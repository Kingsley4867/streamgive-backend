import {
  recordIndexerEventDeadLettered,
  recordIndexerEventProcessed,
  recordIndexerEventsSkipped,
  recordIndexerPosition,
} from '../metrics.js';
import { getLatestLedgerSequence, rpcServer } from '../stellar/rpc.js';
import { getCheckpointState, saveCheckpoint } from './checkpoint.js';
import { WATCHED_CONTRACT_IDS } from './contracts.js';
import { recordDeadLetter } from './deadLetter.js';

const POLL_INTERVAL_MS = Number(process.env.INDEXER_POLL_INTERVAL_MS ?? 5000);
const START_LEDGER = process.env.INDEXER_START_LEDGER
  ? Number(process.env.INDEXER_START_LEDGER)
  : undefined;
const MAX_EVENTS_PER_POLL = process.env.INDEXER_MAX_EVENTS_PER_POLL
  ? Number(process.env.INDEXER_MAX_EVENTS_PER_POLL)
  : undefined;

if (
  MAX_EVENTS_PER_POLL !== undefined &&
  (!Number.isInteger(MAX_EVENTS_PER_POLL) || MAX_EVENTS_PER_POLL < 1)
) {
  throw new Error('INDEXER_MAX_EVENTS_PER_POLL must be a positive integer');
}

/** Ceiling on the backed-off delay. Reached after ~7 consecutive failures at
 *  the default 5s interval, so a long outage still re-checks the endpoint
 *  every 5 minutes instead of drifting out to a delay that would look like a
 *  hung indexer — and so recovery is always detected within the cap. */
const BACKOFF_MAX_MS = 5 * 60_000;

type GetEventsResult = Awaited<ReturnType<typeof rpcServer.getEvents>>;
export type ContractEvent = GetEventsResult['events'][number];
export type EventHandler = (event: ContractEvent) => Promise<void>;

// Cached in memory during the process lifetime so every poll doesn't hit
// the DB just to read the starting point; the source of truth is always
// the `indexer_checkpoints` row, written after every processed event.
let lastProcessedLedger: number | undefined;
let lastProcessedEventId: string | undefined;
export const INDEXER_FAILURE_ESCALATION_THRESHOLD = 5;
let consecutivePollFailures = 0;

/** The RPC rejects an out-of-window startLedger with JSON-RPC -32600 and a
 *  message naming the range it does serve. There is no dedicated error code
 *  for it, so the message is the only signal available. */
function isLedgerOutOfRange(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof (err as { message: unknown }).message === 'string' &&
    (err as { message: string }).message.includes('startLedger must be within the ledger range')
  );
}

/**
 * Distinguishes permanent event shape, decode, and validation errors from
 * transient operational errors (e.g. database blips, timeouts, connection drops).
 *
 * Permanent errors are dead-lettered and skipped so the checkpoint can advance.
 * Transient errors are re-thrown so the worker retries them with backoff without
 * advancing the checkpoint.
 */
export function isDecodeOrValidationError(err: unknown): boolean {
  if (err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError) {
    return true;
  }
  if (err instanceof Error) {
    const name = err.name.toLowerCase();
    if (name.includes('validation') || name.includes('zod') || name.includes('decode')) {
      return true;
    }
    const msg = err.message.toLowerCase();
    if (
      msg.includes('transient') ||
      msg.includes('timeout') ||
      msg.includes('connection') ||
      msg.includes('econnrefused') ||
      msg.includes('database') ||
      msg.includes('deadlock') ||
      msg.includes('network') ||
      msg.includes('econnreset') ||
      msg.includes('socket') ||
      msg.includes('service_unavailable')
    ) {
      return false;
    }
    if (
      msg.includes('scval') ||
      msg.includes('xdr') ||
      msg.includes('strkey') ||
      msg.includes('decode') ||
      msg.includes('validation') ||
      msg.includes('unknown stream') ||
      msg.includes('not iterable') ||
      msg.includes('malformed') ||
      msg.includes('cannot read properties')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * How long to wait before the poll that follows `consecutiveFailures`
 * consecutive poll failures.
 *
 * Zero failures — the normal case — is just the poll interval. The first
 * failure also retries at the poll interval, so a single dropped request
 * costs nothing; from there the delay doubles per failure up to
 * BACKOFF_MAX_MS. Doubling is what keeps an RPC outage from being a
 * constant-rate hammer: 5s, 5s, 10s, 20s, 40s, 80s, 160s, 300s, 300s, ...
 *
 * Exported for the unit test; the caller resets the counter on success.
 */
export function backoffDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) {
    return POLL_INTERVAL_MS;
  }

  // 2 ** n saturates to Infinity long before it overflows, and
  // Math.min(Infinity, BACKOFF_MAX_MS) is the cap, so a long outage can
  // never produce a NaN or a nonsensical delay here.
  return Math.min(POLL_INTERVAL_MS * 2 ** (consecutiveFailures - 1), BACKOFF_MAX_MS);
}

/**
 * Fetches and processes one batch of events, moving the checkpoint forward.
 *
 * Exported for the tests; the running indexer drives this from
 * {@link startIndexer} rather than calling it directly.
 */
export async function pollOnce(handleEvent: EventHandler): Promise<void> {
  if (WATCHED_CONTRACT_IDS.length === 0) {
    return;
  }

  if (lastProcessedLedger === undefined) {
    const saved = await getCheckpointState();

    if (saved !== undefined) {
      lastProcessedLedger = saved.lastLedger;
      lastProcessedEventId = saved.lastEventId;
    } else {
      // Never run before: use INDEXER_START_LEDGER for backfill if set,
      // otherwise start from "now" to avoid replaying all history.
      lastProcessedLedger = START_LEDGER ?? (await getLatestLedgerSequence());
      await saveCheckpoint(lastProcessedLedger);
      recordIndexerPosition(lastProcessedLedger, lastProcessedLedger);
      return;
    }
  }

  // The RPC only serves a sliding window of recent ledgers, and rejects a
  // startLedger on either side of it. Two ways to fall outside:
  //
  //   ahead — we checkpoint at the latest ledger, so the very next poll asks
  //     for latest + 1, which has not closed yet. Nothing to do but wait.
  //   behind — if this process is down longer than the retention window, the
  //     saved checkpoint ages out of it and every later poll fails forever.
  //     Skip ahead to the current ledger; the alternative is an indexer that
  //     never recovers. Events in the gap are lost, so say so loudly.
  const latestLedger = await getLatestLedgerSequence();
  recordIndexerPosition(lastProcessedLedger, latestLedger);

  if (lastProcessedLedger >= latestLedger && lastProcessedEventId === undefined) {
    return;
  }

  let events;

  try {
    const filters = [{ type: 'contract' as const, contractIds: WATCHED_CONTRACT_IDS }];
    const pagination = lastProcessedEventId
      ? { cursor: lastProcessedEventId }
      : { startLedger: lastProcessedLedger + 1 };

    ({ events } = await rpcServer.getEvents({
      ...pagination,
      filters,
      limit: MAX_EVENTS_PER_POLL,
    }));
  } catch (err: unknown) {
    if (isLedgerOutOfRange(err)) {
      console.warn(
        `indexer: checkpoint ${lastProcessedLedger} has aged out of the RPC's` +
          ` retention window — skipping to ledger ${latestLedger}. Events in` +
          ` between were missed and will not be indexed.`,
      );

      lastProcessedLedger = latestLedger;
      lastProcessedEventId = undefined;
      await saveCheckpoint(lastProcessedLedger);
      recordIndexerEventsSkipped();
      return;
    }

    throw err;
  }

  // Nothing happened in the scanned range, but it *was* scanned — advance
  // the checkpoint anyway. Otherwise an idle contract leaves the checkpoint
  // pinned while the chain moves on, until it falls out of the retention
  // window and the recovery above fires on a perfectly healthy indexer.
  if (events.length === 0) {
    lastProcessedLedger = latestLedger;
    lastProcessedEventId = undefined;
    await saveCheckpoint(lastProcessedLedger);
    return;
  }

  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (err: unknown) {
      if (isDecodeOrValidationError(err)) {
        console.error(
          `indexer: event ${event.id} at ledger ${event.ledger} could not be` +
            ` processed (decode/validation error) — recording it as a dead letter and skipping it`,
          err,
        );
        await recordDeadLetter(event, err);
        recordIndexerEventDeadLettered();
      } else {
        console.error(
          `indexer: handler failed transiently for event ${event.id} at ledger ${event.ledger} — ` +
            `will retry with backoff without advancing checkpoint`,
          err,
        );
        throw err;
      }
    } else {
      recordIndexerEventProcessed();
    }

    // Saved per-event, not once per batch: several handlers apply relative
    // deltas (balance -= accrued, etc.), so replaying an already-applied
    // event after a crash would double-count it. Checkpointing after each
    // one bounds the damage to "at most the in-flight event" on a crash.
    lastProcessedLedger = event.ledger;
    lastProcessedEventId = event.id;
    await saveCheckpoint(lastProcessedLedger, lastProcessedEventId);
  }
}

/**
 * Starts polling for contract events.
 *
 * The returned stop function cancels the pending poll and waits for a poll
 * that is already running to finish before resolving.
 */
export function startIndexer(handleEvent: EventHandler): () => Promise<void> {
  if (WATCHED_CONTRACT_IDS.length === 0) {
    // Expected on a fresh local setup before contracts are deployed, not a
    // bug — pollOnce() no-ops until at least one contract id is set. Logged
    // once here (rather than every poll) so it's visible without being noisy.
    console.warn(
      'indexer: NGO_REGISTRY_CONTRACT_ID and DONATION_VAULT_CONTRACT_ID are both unset — no-op until at least one is set. See ENVIRONMENT.md.',
    );
  }

  // Each poll schedules the next one only after it settles, rather than
  // firing on a fixed setInterval. Two things fall out of that: polls can
  // never overlap however slow an RPC is, and a failing poll controls how
  // long until the next attempt instead of the interval timer overriding it.
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let consecutiveFailures = 0;
  let stopped = false;

  function scheduleNextPoll(): void {
    if (stopped) {
      return;
    }
    const delay = backoffDelayMs(consecutiveFailures);
    timer = setTimeout(() => {
      runPoll();
    }, delay);
  }

  function runPoll(): void {
    if (stopped) {
      return;
    }

    inFlight = (async () => {
      try {
        await pollOnce(handleEvent);
        consecutiveFailures = 0;
        consecutivePollFailures = 0;
      } catch (err: unknown) {
        consecutiveFailures += 1;
        consecutivePollFailures += 1;

        if (consecutivePollFailures >= INDEXER_FAILURE_ESCALATION_THRESHOLD) {
          console.error('indexer poll failure threshold exceeded', {
            consecutiveFailures: consecutivePollFailures,
            error: err,
          });
        } else {
          console.error(
            `indexer poll failed (${consecutiveFailures} in a row) — ` +
              `retrying in ${backoffDelayMs(consecutiveFailures)}ms`,
            err,
          );
        }
      } finally {
        inFlight = undefined;
        scheduleNextPoll();
      }
    })();
  }

  runPoll();

  return async (): Promise<void> => {
    stopped = true;
    clearTimeout(timer);
    await inFlight;
  };
}
