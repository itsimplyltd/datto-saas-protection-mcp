/**
 * datto_saas_get_seat must not surface a bare vendor 504.
 *
 * For ~90% of customers the seats route 504s (Datto's own edge limit above
 * ~25-40 seats — see isSeatListingUnavailable in src/datto-api.ts). Before
 * this fix, datto_saas_get_seat had no handling around the listSeats() call
 * it depends on, so the technician got a raw
 * "Error: Datto server error: 504 Gateway Timeout" after ~60s with no
 * indication of why or what to do instead. There is no count that answers
 * "show me this seat" (unlike datto_saas_list_seats, which can degrade to a
 * domain-level count), so this must be a clear, explained failure.
 *
 * Follows the harness pattern in test/seat-degradation.test.ts: drive the
 * real server over an in-memory MCP transport with `fetch` stubbed by URL.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp-server.js';

const TEST_CREDS = { publicKey: 'pk', secretKey: 'sk' };
const CUSTOMER = 53124;

function respond(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 504 ? 'Gateway Timeout' : '',
    headers: { 'content-type': 'application/json' },
  });
}

/** Route by path: only the seats route is exercised by datto_saas_get_seat. */
function routeFetch(seats: () => Response | Promise<Response>) {
  return vi.fn(async (url: string) => {
    if (url.includes('/seats')) return seats();
    return respond(404);
  });
}

async function connectClient(): Promise<Client> {
  const server = createMcpServer(TEST_CREDS);
  const client = new Client({ name: 'get-seat-unavailable-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function getSeat(seatId = 'dana@acme.co.nz') {
  const client = await connectClient();
  return (await client.callTool({
    name: 'datto_saas_get_seat',
    arguments: { saasCustomerId: CUSTOMER, seatId },
  })) as { isError?: boolean; content: Array<{ text?: string }> };
}

describe('datto_saas_get_seat when seats cannot be listed', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('explains the 504 instead of returning it raw', async () => {
    vi.stubGlobal('fetch', routeFetch(() => respond(504)));
    const result = await getSeat();

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('single seat is unavailable');
    expect(text).toContain(String(CUSTOMER));
    expect(text).toContain('datto_saas_list_seats');
    // Not the bare vendor error text.
    expect(text).not.toContain('504 Gateway Timeout');
  });

  it('degrades on a client-side timeout too', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch(() => Promise.reject(new DOMException('timed out', 'TimeoutError')))
    );
    const result = await getSeat();

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('single seat is unavailable');
  });

  it('still surfaces a 401 as itself, not the seats-unavailable message', async () => {
    vi.stubGlobal('fetch', routeFetch(() => respond(401)));
    const result = await getSeat();

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('401');
    expect(text).not.toContain('unavailable for this customer');
  });
});
