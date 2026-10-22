import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';

describe('CORS configuration', () => {
  const originalCorsOrigins = process.env.CORS_ORIGINS;

  afterEach(() => {
    if (originalCorsOrigins === undefined) {
      delete process.env.CORS_ORIGINS;
    } else {
      process.env.CORS_ORIGINS = originalCorsOrigins;
    }
  });

  it('returns CORS headers for configured allowed origin', async () => {
    process.env.CORS_ORIGINS = 'http://localhost:3001,http://localhost:3000';
    const app = buildServer();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: {
        origin: 'http://localhost:3001',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3001');

    await app.close();
  });

  it('handles preflight OPTIONS requests with CORS headers', async () => {
    process.env.CORS_ORIGINS = 'http://localhost:3001';
    const app = buildServer();

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/ngo-applications',
      headers: {
        origin: 'http://localhost:3001',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-admin-address,x-admin-signature,x-admin-timestamp',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3001');
    const allowedHeaders = String(response.headers['access-control-allow-headers'])
      .split(',')
      .map((header) => header.trim().toLowerCase());
    expect(allowedHeaders).toEqual(
      expect.arrayContaining(['x-admin-address', 'x-admin-signature', 'x-admin-timestamp']),
    );

    await app.close();
  });

  it('omits access-control-allow-origin for an origin outside the allowlist', async () => {
    process.env.CORS_ORIGINS = 'https://app.streamgive.example';
    const app = buildServer();

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/ngo-applications',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-admin-address,x-admin-signature,x-admin-timestamp',
      },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();

    await app.close();
  });

  it('advertises PUT, PATCH, and DELETE for browser preflight requests', async () => {
    process.env.CORS_ORIGINS = 'http://localhost:3001';
    const app = buildServer();

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/health',
      headers: {
        origin: 'http://localhost:3001',
        'access-control-request-method': 'PATCH',
      },
    });

    const methods = String(response.headers['access-control-allow-methods'])
      .split(',')
      .map((method) => method.trim().toUpperCase());
    expect(response.statusCode).toBe(204);
    expect(methods).toEqual(expect.arrayContaining(['PUT', 'PATCH', 'DELETE']));

    await app.close();
  });
});
