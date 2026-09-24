import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DattoSaasApi, DEFAULT_TIMEOUT_MS } from '../src/datto-api.js';

// Measured against our tenant, 2026-09-21: /saas/domains ~34s,
// /saas/applications ~19s, /saas/{id}/seats 38-60s and then a 504 at
// Datto's own edge. A client timeout at or below 60s aborts requests that
// were going to succeed - and has already once made us conclude the
// credentials were bad.
const OBSERVED_504_EDGE_MS = 60_000;

describe('request timeout', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sits above the observed 504 edge on the seats endpoint', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(OBSERVED_504_EDGE_MS);
  });

  it('is the timeout the client actually applies when none is passed', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await new DattoSaasApi({ publicKey: 'pk', secretKey: 'sk' }).listDomains();
    expect(spy).toHaveBeenCalledWith(DEFAULT_TIMEOUT_MS);
  });
});
