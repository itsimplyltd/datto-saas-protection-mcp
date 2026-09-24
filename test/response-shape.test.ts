/**
 * Unexpected response shapes must fail loudly, not become an empty list or an
 * undefined body a caller quietly renders as "no data".
 *
 * Before this fix, `getArray` normalised any non-array 200 body to `[]`, and
 * `get` returned `undefined` for a 200 whose body wasn't JSON. Both are the
 * exact silent-failure mode the project's threat model warns about: a real
 * Datto response that doesn't match the documented shape (a contract change,
 * a proxy/WAF error page, a maintenance page) would be reported to the
 * caller as "this customer has no domains" instead of as a shape mismatch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DattoSaasApi, DattoSaasProtectionError, isSeatListingUnavailable } from '../src/datto-api.js';

const fetchMock = vi.fn();

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
}

function api() {
  return new DattoSaasApi({ publicKey: 'pub', secretKey: 'sec' });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getArray: unexpected response shape', () => {
  it('rejects when a 200 body is a JSON object instead of an array', async () => {
    // A fresh Response per call - a Response body can only be read once.
    fetchMock.mockImplementation(() => jsonResponse({ items: [{ domain: 'acme.co.nz' }] }));
    await expect(api().listDomains()).rejects.toBeInstanceOf(DattoSaasProtectionError);
    await expect(api().listDomains()).rejects.toThrow(/unexpected response shape/);
  });

  it('still resolves a real JSON array', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ domain: 'acme.co.nz' }]));
    await expect(api().listDomains()).resolves.toEqual([{ domain: 'acme.co.nz' }]);
  });
});

describe('get: non-JSON 200 response', () => {
  it('rejects a 200 text/html body instead of returning undefined', async () => {
    fetchMock.mockResolvedValue(htmlResponse('<html>maintenance</html>'));
    await expect(api().listDomains()).rejects.toBeInstanceOf(DattoSaasProtectionError);
    await expect(api().listDomains()).rejects.toThrow(/non-JSON/);
  });
});

describe('get: a timeout while reading the body stays a timeout', () => {
  it('propagates a TimeoutError from response.json() unchanged, not as "malformed JSON"', async () => {
    const timeoutError = new DOMException('The operation was aborted', 'TimeoutError');
    const stubResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.reject(timeoutError),
      clone() {
        return this;
      },
    };
    fetchMock.mockResolvedValue(stubResponse as unknown as Response);

    await expect(api().listDomains()).rejects.toBe(timeoutError);
    const error = await api()
      .listDomains()
      .catch((e: unknown) => e);
    expect(isSeatListingUnavailable(error)).toBe(true);
  });
});
