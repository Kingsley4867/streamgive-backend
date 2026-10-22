import { performance } from 'node:perf_hooks';

type HttpKey = `${string}\u0000${string}\u0000${number}`;

const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const httpRequests = new Map<HttpKey, number>();
const httpDuration = new Map<
  HttpKey,
  { count: number; sum: number; buckets: number[] }
>();
const notificationDeliveries = new Map<'success' | 'failure', number>();
const processStartTimeSeconds = Date.now() / 1000 - process.uptime();

let indexerCheckpointLedger = 0;
let indexerLatestLedger = 0;
let indexerEventsProcessed = 0;
let indexerEventsDeadLettered = 0;
let indexerEventsSkipped = 0;

function labels(method: string, route: string, statusCode: number): string {
  return `method="${method}",route="${route.replaceAll('"', '\\"')}",status_code="${statusCode}"`;
}

export function recordHttpRequest(
  method: string,
  route: string,
  statusCode: number,
  durationSeconds: number,
): void {
  const key: HttpKey = `${method}\u0000${route}\u0000${statusCode}`;
  httpRequests.set(key, (httpRequests.get(key) ?? 0) + 1);
  const current = httpDuration.get(key) ?? {
    count: 0,
    sum: 0,
    buckets: HTTP_DURATION_BUCKETS.map(() => 0),
  };
  current.count += 1;
  current.sum += durationSeconds;
  HTTP_DURATION_BUCKETS.forEach((bucket, index) => {
    if (durationSeconds <= bucket) current.buckets[index] += 1;
  });
  httpDuration.set(key, current);
}

export function recordIndexerPosition(checkpointLedger: number, latestLedger: number): void {
  indexerCheckpointLedger = checkpointLedger;
  indexerLatestLedger = latestLedger;
}

export function recordIndexerEventProcessed(): void {
  indexerEventsProcessed += 1;
}

export function recordIndexerEventDeadLettered(): void {
  indexerEventsDeadLettered += 1;
}

/** Counts confirmed skip-ahead operations; the RPC does not reveal how many events were missed. */
export function recordIndexerEventsSkipped(): void {
  indexerEventsSkipped += 1;
}

export function recordNotificationDelivery(outcome: 'success' | 'failure'): void {
  notificationDeliveries.set(outcome, (notificationDeliveries.get(outcome) ?? 0) + 1);
}

export function renderMetrics(): string {
  const lines = [
    '# HELP streamgive_http_requests_total Total HTTP requests handled.',
    '# TYPE streamgive_http_requests_total counter',
  ];

  for (const [key, count] of httpRequests) {
    const [method, route, statusCode] = key.split('\u0000');
    lines.push(
      `streamgive_http_requests_total{${labels(method, route, Number(statusCode))}} ${count}`,
    );
  }

  lines.push(
    '# HELP streamgive_http_request_duration_seconds HTTP request duration in seconds.',
    '# TYPE streamgive_http_request_duration_seconds histogram',
  );
  for (const [key, value] of httpDuration) {
    const [method, route, statusCode] = key.split('\u0000');
    const metricLabels = labels(method, route, Number(statusCode));
    HTTP_DURATION_BUCKETS.forEach((bucket, index) => {
      lines.push(
        `streamgive_http_request_duration_seconds_bucket{${metricLabels},le="${bucket}"} ${value.buckets[index]}`,
      );
    });
    lines.push(
      `streamgive_http_request_duration_seconds_bucket{${metricLabels},le="+Inf"} ${value.count}`,
      `streamgive_http_request_duration_seconds_sum{${metricLabels}} ${value.sum}`,
      `streamgive_http_request_duration_seconds_count{${metricLabels}} ${value.count}`,
    );
  }

  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  lines.push(
    '# HELP process_cpu_seconds_total Total user and system CPU time spent in seconds.',
    '# TYPE process_cpu_seconds_total counter',
    `process_cpu_seconds_total ${(cpu.user + cpu.system) / 1_000_000}`,
    '# HELP process_start_time_seconds Start time of the process since the Unix epoch in seconds.',
    '# TYPE process_start_time_seconds gauge',
    `process_start_time_seconds ${processStartTimeSeconds}`,
    '# HELP process_resident_memory_bytes Resident memory size in bytes.',
    '# TYPE process_resident_memory_bytes gauge',
    `process_resident_memory_bytes ${memory.rss}`,
    '# HELP nodejs_heap_size_total_bytes Total size of the V8 heap in bytes.',
    '# TYPE nodejs_heap_size_total_bytes gauge',
    `nodejs_heap_size_total_bytes ${memory.heapTotal}`,
    '# HELP nodejs_heap_size_used_bytes Used size of the V8 heap in bytes.',
    '# TYPE nodejs_heap_size_used_bytes gauge',
    `nodejs_heap_size_used_bytes ${memory.heapUsed}`,
    '# HELP nodejs_external_memory_bytes Memory used by C++ objects bound to JavaScript objects.',
    '# TYPE nodejs_external_memory_bytes gauge',
    `nodejs_external_memory_bytes ${memory.external}`,
    '# HELP nodejs_arraybuffer_bytes Memory allocated for ArrayBuffers and SharedArrayBuffers.',
    '# TYPE nodejs_arraybuffer_bytes gauge',
    `nodejs_arraybuffer_bytes ${memory.arrayBuffers}`,
    '# HELP nodejs_eventloop_utilization Event loop utilization since process start.',
    '# TYPE nodejs_eventloop_utilization gauge',
    `nodejs_eventloop_utilization ${performance.eventLoopUtilization().utilization}`,
    '# HELP streamgive_indexer_checkpoint_ledger Last ledger checkpointed by the indexer.',
    '# TYPE streamgive_indexer_checkpoint_ledger gauge',
    `streamgive_indexer_checkpoint_ledger ${indexerCheckpointLedger}`,
    '# HELP streamgive_indexer_latest_ledger Latest ledger observed from Stellar RPC.',
    '# TYPE streamgive_indexer_latest_ledger gauge',
    `streamgive_indexer_latest_ledger ${indexerLatestLedger}`,
    '# HELP streamgive_indexer_lag_ledgers Difference between the latest and checkpoint ledgers.',
    '# TYPE streamgive_indexer_lag_ledgers gauge',
    `streamgive_indexer_lag_ledgers ${Math.max(0, indexerLatestLedger - indexerCheckpointLedger)}`,
    '# HELP streamgive_indexer_events_processed_total Events successfully processed by the indexer.',
    '# TYPE streamgive_indexer_events_processed_total counter',
    `streamgive_indexer_events_processed_total ${indexerEventsProcessed}`,
    '# HELP streamgive_indexer_events_dead_lettered_total Events stored as dead letters.',
    '# TYPE streamgive_indexer_events_dead_lettered_total counter',
    `streamgive_indexer_events_dead_lettered_total ${indexerEventsDeadLettered}`,
    '# HELP streamgive_indexer_events_skipped_total Confirmed out-of-range skip-ahead operations.',
    '# TYPE streamgive_indexer_events_skipped_total counter',
    `streamgive_indexer_events_skipped_total ${indexerEventsSkipped}`,
    '# HELP streamgive_notification_deliveries_total Webhook notification delivery attempts.',
    '# TYPE streamgive_notification_deliveries_total counter',
  );

  for (const outcome of ['success', 'failure'] as const) {
    lines.push(
      `streamgive_notification_deliveries_total{outcome="${outcome}"} ${notificationDeliveries.get(outcome) ?? 0}`,
    );
  }

  return `${lines.join('\n')}\n`;
}
