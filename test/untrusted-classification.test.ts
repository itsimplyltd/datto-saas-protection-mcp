import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp-server.js';
import {
  TRUSTED_CONTENT_TOOLS,
  UNTRUSTED_CONTENT_TOOLS,
  stripUntrustedContentWrapper,
} from '../src/utils/untrusted-content.js';

const TEST_CREDS = { publicKey: 'pk', secretKey: 'sk' };
const CUSTOMER = 53124;

async function connectClient(): Promise<Client> {
  const server = createMcpServer(TEST_CREDS);
  const client = new Client({ name: 'classification-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function registeredToolNames(): Promise<string[]> {
  const { tools } = await (await connectClient()).listTools();
  return tools.map((t) => t.name);
}

describe('untrusted-content classification', () => {
  afterEach(() => vi.unstubAllGlobals());

  // A tool nobody has classified is a decision nobody made. This fails for
  // every new tool until someone puts it in one set or the other.
  it('classifies every registered tool exactly once', async () => {
    for (const name of await registeredToolNames()) {
      const marked = UNTRUSTED_CONTENT_TOOLS.has(name);
      const unmarked = TRUSTED_CONTENT_TOOLS.has(name);
      expect(marked !== unmarked, `${name} must be in exactly one of UNTRUSTED_/TRUSTED_CONTENT_TOOLS`).toBe(true);
    }
  });

  // The 9-to-7 rename is exactly how a set ends up naming tools that are gone.
  it('names no tool that is not registered', async () => {
    const registered = new Set(await registeredToolNames());
    for (const name of [...UNTRUSTED_CONTENT_TOOLS, ...TRUSTED_CONTENT_TOOLS]) {
      expect(registered.has(name), `${name} is classified but no longer registered`).toBe(true);
    }
  });

  // Proves the choke point in mcp-server.ts survived the merge: set
  // membership alone says nothing about whether results get wrapped.
  it('wraps a marked tool end to end and leaves an unmarked one alone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = url.includes('/seats')
          ? [{ mainId: 'dana@acme.co.nz', name: 'Dana', seatType: 'User', seatState: 'Active', billable: '1' }]
          : [{ domain: 'acme.co.nz', saasCustomerId: CUSTOMER, saasCustomerName: 'Acme', seatsUsed: 1 }];
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      })
    );
    const client = await connectClient();

    const marked = (await client.callTool({ name: 'datto_saas_list_seats', arguments: { saasCustomerId: CUSTOMER } })) as {
      content: Array<{ text?: string }>;
    };
    const unmarked = (await client.callTool({ name: 'datto_saas_list_clients', arguments: {} })) as {
      content: Array<{ text?: string }>;
    };

    const markedText = marked.content[0]?.text ?? '';
    const unmarkedText = unmarked.content[0]?.text ?? '';
    expect(stripUntrustedContentWrapper(markedText)).not.toBe(markedText);
    expect(stripUntrustedContentWrapper(unmarkedText)).toBe(unmarkedText);
  });
});
