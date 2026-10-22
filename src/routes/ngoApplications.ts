import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAdminSignature, sep53Hash } from '../middleware/adminAuth.js';
import { notify } from '../notifications/service.js';

const APPLICATION_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Submission body: `ownerAddress` must be a Stellar G... public key;
 * `name` and `description` are required (1–200 and 1–5000 characters);
 * `contactEmail` is a required email; optional `website` is normalized to
 * HTTPS when scheme-less and must be a URL; optional `country` is at most
 * 100 characters. `challenge` and `signature` prove control of ownerAddress.
 */
const applicationSchema = z.object({
  ownerAddress: z.string().regex(/^G[A-Z2-7]{55}$/),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  // Normalize scheme-less domains (e.g. "example.org") to "https://example.org"
  // before URL validation so applicants who omit the scheme aren't blocked.
  website: z
    .string()
    .transform((val) => (val && !/^https?:\/\//i.test(val) ? `https://${val}` : val))
    .pipe(z.string().url())
    .optional(),
  contactEmail: z.string().email(),
  country: z.string().max(100).optional(),
});

const applicationSubmissionSchema = applicationSchema.extend({
  challenge: z.string().uuid(),
  signature: z.string().min(1),
});

const challengeRequestSchema = z.object({
  ownerAddress: z.string().regex(/^G[A-Z2-7]{55}$/),
});

function applicationChallengeMessage(ownerAddress: string, challenge: string, expiresAt: Date) {
  return [
    'StreamGive NGO application address verification',
    `Owner address: ${ownerAddress}`,
    `Challenge: ${challenge}`,
    `Expires at: ${expiresAt.toISOString()}`,
  ].join('\n');
}

function verifyApplicationSignature(
  ownerAddress: string,
  message: string,
  signature: string,
): boolean {
  try {
    if (!StrKey.isValidEd25519PublicKey(ownerAddress)) return false;
    const keypair = Keypair.fromPublicKey(ownerAddress);
    const candidates = [Buffer.from(signature, 'base64'), Buffer.from(signature, 'hex')];
    return candidates.some(
      (candidate) => candidate.length === 64 && keypair.verify(sep53Hash(message), candidate),
    );
  } catch {
    return false;
  }
}

/**
 * Query for the admin list: optional status (`PENDING`, `APPROVED`, or
 * `REJECTED`), `limit` from 1–100 (default 100), and non-negative `offset`
 * (default 0).
 */
const listQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Params for application detail and review routes; `id` must be an application UUID. */
const idParamSchema = z.object({ id: z.string().uuid() });

/** Query for the public status lookup; `ownerAddress` must be a Stellar G... public key. */
const statusQuerySchema = z.object({
  // Stellar StrKey ed25519 public key: 'G' + 55 base32 (A-Z2-7) chars.
  // Same regex as GET /ngos/lookup.
  ownerAddress: z.string().regex(/^G[A-Z2-7]{55}$/),
});

/** Review body for approve/reject; optional `reviewNote` is at most 2000 characters. */
const reviewBodySchema = z.object({
  reviewNote: z.string().max(2000).optional(),
});

/**
 * Inserts a PENDING application, or reports the application that already
 * blocks this address.
 *
 * Read-then-write is a race on its own: two POSTs that arrive together both
 * read "nothing blocking", both insert, and one address ends up with two
 * PENDING applications. The obvious remedy — a partial unique index on
 * (owner_address) WHERE status = 'PENDING' — is not available here. This
 * project syncs its schema with `prisma db push` and has no migration files
 * (see DEPLOYMENT.md), so a raw index would never be applied, and Prisma's
 * schema language cannot express a partial index anyway.
 *
 * So the insert is serialised in the database instead: a transaction-scoped
 * advisory lock keyed on the owner address. The second request blocks until
 * the first transaction commits, then re-reads inside its own transaction and
 * sees the row the winner inserted, taking the 409 path. Postgres releases
 * the lock at COMMIT or ROLLBACK, so a crashed request cannot wedge the
 * address, and a `hashtext` collision only serialises two unrelated addresses
 * — it can never let a duplicate through.
 */
async function createApplicationUnlessBlocked(data: z.infer<typeof applicationSchema>) {
  return prisma.$transaction(async (tx) => {
    // `::text` pins the bind parameter's type instead of leaving it to the
    // server to infer.
    // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns `void`, which
    // the pg driver adapter cannot deserialize into a JS value. $executeRaw
    // only needs the row count, so it sidesteps the unsupported column type.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${data.ownerAddress}::text)::bigint)`;

    const existingApp = await tx.ngoApplication.findFirst({
      where: {
        ownerAddress: data.ownerAddress,
        status: { in: ['PENDING', 'APPROVED'] },
      },
    });
    if (existingApp) {
      return { ok: false as const, status: existingApp.status };
    }

    return { ok: true as const, application: await tx.ngoApplication.create({ data }) };
  });
}

export async function ngoApplicationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Issues a short-lived challenge that must be signed by the NGO owner address.
   * @route POST /v1/ngo-applications/challenge
   * @body `{ ownerAddress }`
   * @returns 201 `{ challenge, message, expiresAt }`.
   */
  app.post('/ngo-applications/challenge', async (request, reply) => {
    const parsed = challengeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    }
    if (!StrKey.isValidEd25519PublicKey(parsed.data.ownerAddress)) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const challenge = randomUUID();
    const expiresAt = new Date(Date.now() + APPLICATION_CHALLENGE_TTL_MS);
    const message = applicationChallengeMessage(parsed.data.ownerAddress, challenge, expiresAt);
    await prisma.ngoApplicationChallenge.deleteMany({
      where: { expiresAt: { lte: new Date() } },
    });
    await prisma.ngoApplicationChallenge.create({
      data: { challenge, ownerAddress: parsed.data.ownerAddress, expiresAt },
    });

    return reply.code(201).send({ challenge, message, expiresAt });
  });

  /**
   * Submits a public NGO verification application.
   * @route POST /v1/ngo-applications
   * @body applicationSchema plus a server-issued `challenge` and SEP-53 `signature`
   * @auth Public
   * @returns 201 created application; 400 invalid request or signature; 409 `{ error: "already_approved" | "application_already_pending" }`.
   */
  app.post(
    '/ngo-applications',
    // Public write endpoint — tighter than the global default since it's
    // the most spam-prone route in the API.
    {
      config: {
        rateLimit: {
          max: Number(process.env.RATE_LIMIT_APPLICATION_MAX ?? 5),
          timeWindow: process.env.RATE_LIMIT_APPLICATION_WINDOW ?? '1 minute',
        },
      },
    },
    async (request, reply) => {
      const parsed = applicationSubmissionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
      }

      const { challenge, signature, ...applicationData } = parsed.data;
      const challengeRecord = await prisma.ngoApplicationChallenge.findUnique({
        where: { challenge },
      });
      if (
        !challengeRecord ||
        challengeRecord.ownerAddress !== applicationData.ownerAddress ||
        challengeRecord.expiresAt.getTime() <= Date.now()
      ) {
        return reply.code(400).send({ error: 'invalid_or_expired_challenge' });
      }

      const message = applicationChallengeMessage(
        challengeRecord.ownerAddress,
        challenge,
        challengeRecord.expiresAt,
      );
      if (!verifyApplicationSignature(applicationData.ownerAddress, message, signature)) {
        return reply.code(401).send({ error: 'invalid_signature' });
      }

      const consumed = await prisma.ngoApplicationChallenge.deleteMany({
        where: {
          challenge,
          ownerAddress: applicationData.ownerAddress,
          expiresAt: { gt: new Date() },
        },
      });
      if (consumed.count !== 1) {
        return reply.code(400).send({ error: 'invalid_or_expired_challenge' });
      }

      const result = await createApplicationUnlessBlocked(applicationData);
      if (!result.ok) {
        if (result.status === 'APPROVED') {
          return reply.code(409).send({ error: 'already_approved' });
        }
        return reply.code(409).send({ error: 'application_already_pending' });
      }

      await notify({
        type: 'application_submitted',
        applicationId: result.application.id,
        ownerAddress: result.application.ownerAddress,
        name: result.application.name,
      });
      return reply.code(201).send(result.application);
    },
  );

  // Public read endpoint: an applicant can check their own review status
  // without an admin signature. Deliberately returns only the review
  // outcome, timestamps, and (after review) the review note — never contact
  // details or the description submitted with the application, since anyone
  // who knows (or guesses) an address could otherwise read them.
  /**
   * Returns the latest application status without exposing submitted details.
   * @route GET /v1/ngo-applications/status
   * @query ownerAddress Stellar public key
   * @auth Public
   * @returns 200 `{ status, createdAt, updatedAt, reviewNote? }`; the note
   * is returned after review. 400 invalid address; 404 `{ error: "not_found" }`.
   */
  app.get(
    '/ngo-applications/status',
    {
      schema: {
        tags: ['NGOs'],
        summary: 'Check an NGO application status',
        description:
          'Returns the status and timestamps, plus the review note after review, for the supplied owner address.',
        querystring: {
          type: 'object',
          properties: { ownerAddress: { type: 'string', pattern: '^G[A-Z2-7]{55}$' } },
          required: ['ownerAddress'],
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: { type: 'object', additionalProperties: true },
          404: { type: 'object', additionalProperties: true },
          503: { type: 'object', additionalProperties: true },
        },
      },
    },
    async (request, reply) => {
      const parsed = statusQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
      }

      const application = await prisma.ngoApplication.findFirst({
        where: { ownerAddress: parsed.data.ownerAddress },
        orderBy: { createdAt: 'desc' },
        select: { status: true, createdAt: true, updatedAt: true, reviewNote: true },
      });
      if (!application) {
        return reply.code(404).send({ error: 'not_found' });
      }

      if (application.status === 'PENDING') {
        return {
          status: application.status,
          createdAt: application.createdAt,
          updatedAt: application.updatedAt,
        };
      }
      return application;
    },
  );

  // Admin dashboard endpoint: returns application counts grouped by
  // status so the client doesn't have to fetch and count applications
  // itself. Must be registered before the /:id route so 'stats' isn't
  // swallowed as an id and rejected by the UUID param validation.
  /**
   * Counts applications grouped by review status.
   * @route GET /v1/ngo-applications/stats
   * @auth Admin signature required via `x-admin-address`, `x-admin-timestamp`, and `x-admin-signature`.
   * @returns 200 `{ counts: { PENDING, APPROVED, REJECTED }, total }`.
   */
  app.get('/ngo-applications/stats', { preHandler: requireAdminSignature }, async () => {
    const grouped = await prisma.ngoApplication.groupBy({
      by: ['status'],
      _count: { _all: true },
    });

    const counts = { PENDING: 0, APPROVED: 0, REJECTED: 0 } as Record<string, number>;
    for (const row of grouped) {
      counts[row.status] = row._count._all;
    }

    const total = counts.PENDING + counts.APPROVED + counts.REJECTED;

    return {
      counts: { PENDING: counts.PENDING, APPROVED: counts.APPROVED, REJECTED: counts.REJECTED },
      total,
    };
  });

  /**
   * Lists applications newest first with optional status and offset pagination.
   * @route GET /v1/ngo-applications
   * @query status, limit, offset
   * @auth Admin signature required via `x-admin-address`, `x-admin-timestamp`, and `x-admin-signature`.
   * @returns 200 `{ applications: Application[], total, limit, offset }`; 400 `{ error: "invalid_request", details }`.
   */
  app.get('/ngo-applications', { preHandler: requireAdminSignature }, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    }

    const where = parsed.data.status ? { status: parsed.data.status } : {};

    const [applications, total] = await Promise.all([
      prisma.ngoApplication.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: parsed.data.limit,
        skip: parsed.data.offset,
      }),
      prisma.ngoApplication.count({ where }),
    ]);

    return { applications, total, limit: parsed.data.limit, offset: parsed.data.offset };
  });

  /**
   * Returns a single application, including its submitted and review details.
   * @route GET /v1/ngo-applications/:id
   * @param id Application UUID
   * @auth Admin signature required via `x-admin-address`, `x-admin-timestamp`, and `x-admin-signature`.
   * @returns 200 application; 400 invalid UUID; 404 `{ error: "not_found" }`.
   */
  app.get(
    '/ngo-applications/:id',
    { preHandler: requireAdminSignature },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }

      const application = await prisma.ngoApplication.findUnique({
        where: { id: parsedParams.data.id },
      });
      if (!application) {
        return reply.code(404).send({ error: 'not_found' });
      }

      return application;
    },
  );

  /**
   * Approves a pending application and optionally records a review note.
   * @route POST /v1/ngo-applications/:id/approve
   * @param id Application UUID
   * @body Optional `{ reviewNote?: string }` (maximum 2000 characters)
   * @auth Admin signature required via `x-admin-address`, `x-admin-timestamp`, and `x-admin-signature`.
   * @returns 200 updated application; 400 invalid params/body; 404 `{ error: "not_found" }`; 409 `{ error: "already_reviewed" }`.
   */
  app.post(
    '/ngo-applications/:id/approve',
    { preHandler: requireAdminSignature },
    async (request, reply) => {
      const reviewedBy = request.headers['x-admin-address'];
      if (typeof reviewedBy !== 'string') {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const { id } = parsedParams.data;

      const parsed = reviewBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
      }

      const application = await prisma.ngoApplication.findUnique({ where: { id } });
      if (!application) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (application.status !== 'PENDING') {
        return reply.code(409).send({ error: 'already_reviewed' });
      }

      try {
        const reviewed = await prisma.ngoApplication.update({
          where: { id, status: 'PENDING' },
          data: {
            status: 'APPROVED',
            reviewNote: parsed.data?.reviewNote,
            reviewedBy,
            reviewedAt: new Date(),
          },
        });
        await notify({
          type: 'application_reviewed',
          applicationId: reviewed.id,
          ownerAddress: reviewed.ownerAddress,
          status: 'APPROVED',
          ...(reviewed.reviewNote ? { reviewNote: reviewed.reviewNote } : {}),
        });
        return reviewed;
      } catch (err) {
        if (
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: string }).code === 'P2025'
        ) {
          return reply.code(404).send({ error: 'not_found' });
        }
        throw err;
      }
    },
  );

  /**
   * Rejects a pending application and optionally records a review note.
   * @route POST /v1/ngo-applications/:id/reject
   * @param id Application UUID
   * @body Optional `{ reviewNote?: string }` (maximum 2000 characters)
   * @auth Admin signature required via `x-admin-address`, `x-admin-timestamp`, and `x-admin-signature`.
   * @returns 200 updated application; 400 invalid params/body; 404 `{ error: "not_found" }`; 409 `{ error: "already_reviewed" }`.
   */
  app.post(
    '/ngo-applications/:id/reject',
    { preHandler: requireAdminSignature },
    async (request, reply) => {
      const reviewedBy = request.headers['x-admin-address'];
      if (typeof reviewedBy !== 'string') {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const { id } = parsedParams.data;

      const parsed = reviewBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
      }

      const application = await prisma.ngoApplication.findUnique({ where: { id } });
      if (!application) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (application.status !== 'PENDING') {
        return reply.code(409).send({ error: 'already_reviewed' });
      }

      try {
        const reviewed = await prisma.ngoApplication.update({
          where: { id, status: 'PENDING' },
          data: {
            status: 'REJECTED',
            reviewNote: parsed.data?.reviewNote,
            reviewedBy,
            reviewedAt: new Date(),
          },
        });
        await notify({
          type: 'application_reviewed',
          applicationId: reviewed.id,
          ownerAddress: reviewed.ownerAddress,
          status: 'REJECTED',
          ...(reviewed.reviewNote ? { reviewNote: reviewed.reviewNote } : {}),
        });
        return reviewed;
      } catch (err) {
        if (
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: string }).code === 'P2025'
        ) {
          return reply.code(404).send({ error: 'not_found' });
        }
        throw err;
      }
    },
  );
}
