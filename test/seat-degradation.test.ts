import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp-server.js';
import { DattoSaasApi, isSeatListingUnavailable } from '../src/datto-api.js';
import { SEATS_UNAVAILABLE_NOTE } from '../src/derived.js';
import { stripUntrustedContentWrapper } from '../src/utils/untrusted-content.js';

const TEST_CREDS = { publicKey: 'pk', secretKey: 'sk' };
const CUSTOMER = 53124;

const DOMAINS = [
  { domain: 'acme.co.nz', saasCustomerId: CUSTOMER, saasCustomerName: 'Acme', seatsUsed: 200, productType: 'Office365' },
  { domain: 'acme-legacy.co.nz', saasCustomerId: CUSTOMER, saasCustomerName: 'Acme', seatsUsed: 14, productType: 'GoogleApps' },
  { domain: 'other.co.nz', saasCustomerId: 99999, saasCustomerName: 'Other', seatsUsed: 7, productType: 'Office365' },
];

function respond(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 504 ? 'Gateway Timeout' : '',
    headers: { 'content-type': 'application/json' },
  });
}

/** Route by path: /v1/saas/domains answers; the seats route does whatever `seats` says. */
function routeFetch(seats: () => Response | Promise<Response>) {
  return vi.fn(async (url: string) => {
    if (url.includes('/v1/saas/domains')) return respond(200, DOMAINS);
    if (url.includes('/seats')) return seats();
    return respond(404);
  });
}

async function connectClient(): Promise<Client> {
  const server = createMcpServer(TEST_CREDS);
  const client = new Client({ name: 'seat-degradation-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function listSeats(args: Record<string, unknown>) {
  const client = await connectClient();
  return (await client.callTool({ name: 'datto_saas_list_seats', arguments: args })) as {
    isError?: boolean;
    content: Array<{ text?: string }>;
  };
}

async function errorFrom(seats: () => Response | Promise<Response>): Promise<unknown> {
  vi.stubGlobal('fetch', routeFetch(seats));
  try {
    await new DattoSaasApi(TEST_CREDS).listSeats(CUSTOMER);
  } catch (error) {
    return error;
  }
  throw new Error('expected listSeats to throw');
}

describe('isSeatListingUnavailable', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is true for a 504 from Datto', async () => {
    expect(isSeatListingUnavailable(await errorFrom(() => respond(504)))).toBe(true);
  });

  it('is true for our own client-side timeout', () => {
    expect(isSeatListingUnavailable(new DOMException('timed out', 'TimeoutError'))).toBe(true);
  });

  it.each([401, 403, 404, 500, 502, 503])('is false for HTTP %i', async (status) => {
    expect(isSeatListingUnavailable(await errorFrom(() => respond(status)))).toBe(false);
  });

  it('is false for an unrelated error', () => {
    expect(isSeatListingUnavailable(new Error('boom'))).toBe(false);
  });
});

describe('datto_saas_list_seats degradation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('falls back to the domain-level count when the seats route 504s', async () => {
    vi.stubGlobal('fetch', routeFetch(() => respond(504)));
    const result = await listSeats({ saasCustomerId: CUSTOMER });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(stripUntrustedContentWrapper(result.content[0]?.text ?? '{}'));
    expect(payload).toEqual({
      saasCustomerId: CUSTOMER,
      seatsUsed: 214,
      seatDetail: null,
      domains: [
        { domain: 'acme.co.nz', productType: 'Office365', seatsUsed: 200 },
        { domain: 'acme-legacy.co.nz', productType: 'GoogleApps', seatsUsed: 14 },
      ],
      note: SEATS_UNAVAILABLE_NOTE,
    });
  });

  it('falls back on a client-side timeout too', async () => {
    vi.stubGlobal('fetch', routeFetch(() => Promise.reject(new DOMException('timed out', 'TimeoutError'))));
    const result = await listSeats({ saasCustomerId: CUSTOMER });
    const payload = JSON.parse(stripUntrustedContentWrapper(result.content[0]?.text ?? '{}'));
    expect(payload.seatDetail).toBeNull();
    expect(payload.seatsUsed).toBe(214);
  });

  it('says so when a seatType filter could not be applied to the count', async () => {
    vi.stubGlobal('fetch', routeFetch(() => respond(504)));
    const result = await listSeats({ saasCustomerId: CUSTOMER, seatType: ['User'] });
    const payload = JSON.parse(stripUntrustedContentWrapper(result.content[0]?.text ?? '{}'));
    expect(payload.note).toContain('seatType filter could not be applied');
  });

  it('does NOT degrade on a 401 - bad credentials must surface as bad credentials', async () => {
    vi.stubGlobal('fetch', routeFetch(() => respond(401)));
    const result = await listSeats({ saasCustomerId: CUSTOMER });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('401');
  });

  it('fails clearly when there is no domain record to fall back on', async () => {
    vi.stubGlobal('fetch', routeFetch(() => respond(504)));
    const result = await listSeats({ saasCustomerId: 12345 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no domain record');
  });

  it('returns the real seat list untouched when the seats route answers', async () => {
    const seat = { mainId: 'dana@acme.co.nz', name: 'Dana', seatType: 'User', seatState: 'Active', billable: '1' };
    vi.stubGlobal('fetch', routeFetch(() => respond(200, [seat])));
    const result = await listSeats({ saasCustomerId: CUSTOMER });
    const payload = JSON.parse(stripUntrustedContentWrapper(result.content[0]?.text ?? '{}'));
    expect(payload).toEqual([seat]);
  });
});
