import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';
import * as rpc from '../../src/stellar/rpc.js';

describe('GET /health', () => {
  beforeEach(() => {
    vi.spyOn(prisma, '$queryRaw').mockResolvedValue([{}]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('responds with 200 when both database and RPC are reachable', async () => {
    vi.spyOn(rpc, 'getLatestLedgerSequence').mockResolvedValueOnce(1);

    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', db: 'ok', rpc: 'ok' });

    await app.close();
  });

  it('serves Swagger UI and an OpenAPI document in development', async () => {
    const app = buildServer();
    const ui = await app.inject({ method: 'GET', url: '/docs/' });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers['content-type']).toContain('text/html');
    const spec = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(spec.statusCode).toBe(200);
    expect(spec.json().openapi).toMatch(/^3\./);
    expect(spec.json().paths['/v1/streams']).toBeDefined();
    expect(spec.json().paths['/v1/ngos']).toBeDefined();
    await app.close();
  });

  it('responds with 503 when the database is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('connection refused'));
    vi.spyOn(rpc, 'getLatestLedgerSequence').mockResolvedValueOnce(1);

    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'error', db: 'error', rpc: 'ok' });

    await app.close();

    await app.close();
  });

  it('responds with 503 when the RPC endpoint is unreachable', async () => {
    vi.spyOn(rpc, 'getLatestLedgerSequence').mockRejectedValueOnce(new Error('RPC unreachable'));
    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'error', db: 'ok', rpc: 'error' });
    await app.close();
  });

  it('applies the global rate limit to repeated health checks', async () => {
    const previousMax = process.env.RATE_LIMIT_MAX;
    process.env.RATE_LIMIT_MAX = '1';
    vi.spyOn(rpc, 'getLatestLedgerSequence').mockResolvedValue(1);
    const app = buildServer();

    const first = await app.inject({ method: 'GET', url: '/health' });
    const second = await app.inject({ method: 'GET', url: '/health' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);

    await app.close();
    if (previousMax === undefined) delete process.env.RATE_LIMIT_MAX;
    else process.env.RATE_LIMIT_MAX = previousMax;
  });
});

describe('GET /health/ready', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('responds with 200 and status ok when DB and RPC are reachable and lag is within threshold', async () => {
    vi.spyOn(await import('../../src/stellar/rpc.js'), 'getLatestLedgerSequence').mockResolvedValue(
      10050,
    );
    vi.spyOn(await import('../../src/indexer/checkpoint.js'), 'getCheckpoint').mockResolvedValue(
      10000,
    );

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      lag: 50,
      latestLedger: 10050,
      checkpointLedger: 10000,
    });

    await app.close();
  });

  it('responds with 503 when the database is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('Database connection failed'));

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', reason: 'service_unavailable' });

    await app.close();
  });

  it('responds with 503 when RPC is unreachable', async () => {
    vi.spyOn(await import('../../src/stellar/rpc.js'), 'getLatestLedgerSequence').mockRejectedValue(new Error('RPC connection failed'));
    vi.spyOn(await import('../../src/indexer/checkpoint.js'), 'getCheckpoint').mockResolvedValue(10000);

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', reason: 'service_unavailable' });

    await app.close();
  });

  it('responds with 503 when indexer has no checkpoint', async () => {
    vi.spyOn(await import('../../src/stellar/rpc.js'), 'getLatestLedgerSequence').mockResolvedValue(10050);
    vi.spyOn(await import('../../src/indexer/checkpoint.js'), 'getCheckpoint').mockResolvedValue(undefined);

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', reason: 'indexer_not_started' });

    await app.close();
  });

  it('responds with 503 when indexer lag is above threshold', async () => {
    vi.spyOn(await import('../../src/stellar/rpc.js'), 'getLatestLedgerSequence').mockResolvedValue(10150);
    vi.spyOn(await import('../../src/indexer/checkpoint.js'), 'getCheckpoint').mockResolvedValue(10000);

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', reason: 'indexer_lagging', lag: 150, threshold: 100 });

    await app.close();
  });

  it('parses INDEXER_LAG_THRESHOLD as NaN for non-numeric values and treats them as 0', async () => {
    const original = process.env.INDEXER_LAG_THRESHOLD;
    process.env.INDEXER_LAG_THRESHOLD = 'abc';

    vi.spyOn(await import('../../src/stellar/rpc.js'), 'getLatestLedgerSequence').mockResolvedValue(10001);
    vi.spyOn(await import('../../src/indexer/checkpoint.js'), 'getCheckpoint').mockResolvedValue(10000);

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe('error');
    expect(body.reason).toBe('indexer_lagging');
    expect(body.lag).toBe(1);
    expect(isNaN(body.threshold)).toBe(true);

    await app.close();

    if (original === undefined) delete process.env.INDEXER_LAG_THRESHOLD;
    else process.env.INDEXER_LAG_THRESHOLD = original;
  });
});
