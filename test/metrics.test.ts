import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/routes/ngoApplications.js', () => ({
  ngoApplicationRoutes: async () => {},
}));

import { buildServer } from '../src/server.js';
import {
  recordIndexerEventDeadLettered,
  recordIndexerEventProcessed,
  recordIndexerEventsSkipped,
  renderMetrics,
} from '../src/metrics.js';

describe('GET /metrics', () => {
  it('returns Prometheus text with HTTP and indexer metrics', async () => {
    const app = buildServer();

    await app.inject({ method: 'GET', url: '/not-a-route' });
    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('# TYPE streamgive_http_requests_total counter');
    expect(response.body).toContain(
      'streamgive_http_requests_total{method="GET",route="unmatched",status_code="404"}',
    );
    expect(response.body).toContain('# TYPE streamgive_http_request_duration_seconds histogram');
    expect(response.body).toContain('streamgive_http_request_duration_seconds_bucket');
    expect(response.body).toContain('# TYPE streamgive_indexer_lag_ledgers gauge');
    expect(response.body).toContain('streamgive_indexer_checkpoint_ledger 0');
    expect(response.body).toContain('# TYPE process_resident_memory_bytes gauge');
    expect(response.body).toContain('# TYPE nodejs_eventloop_utilization gauge');
    expect(response.body).toContain('# TYPE streamgive_notification_deliveries_total counter');

    await app.close();
  });

  it('increments processed, dead-lettered, and skipped indexer counters', () => {
    const before = renderMetrics();
    const value = (metrics: string, name: string) =>
      Number(metrics.match(new RegExp(`^${name} (\\d+)$`, 'm'))?.[1]);

    recordIndexerEventProcessed();
    recordIndexerEventDeadLettered();
    recordIndexerEventsSkipped();

    const after = renderMetrics();
    expect(value(after, 'streamgive_indexer_events_processed_total')).toBe(
      value(before, 'streamgive_indexer_events_processed_total') + 1,
    );
    expect(value(after, 'streamgive_indexer_events_dead_lettered_total')).toBe(
      value(before, 'streamgive_indexer_events_dead_lettered_total') + 1,
    );
    expect(value(after, 'streamgive_indexer_events_skipped_total')).toBe(
      value(before, 'streamgive_indexer_events_skipped_total') + 1,
    );
  });
});
