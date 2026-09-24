/**
 * resolveSaasCustomerId (src/mcp-server.ts) used to wrap its whole body in a
 * try/catch that returned null on any failure, so a 401 or a timeout from
 * api.listDomains() - the call it makes to look up the customer when none was
 * supplied - was indistinguishable from "there are no customers to resolve",
 * and got reported to the caller as "Error: saasCustomerId is required."
 * That hides the real, actionable problem (bad credentials, a timeout) behind
 * a misleading one (a missing argument the caller may not even control, e.g.
 * an LLM that omitted it because there's normally exactly one customer).
 *
 * Fix: only elicitSelection()'s own failure (a client with no elicitation
 * support) is caught and turned into null; api.listDomains() errors propagate
 * to the outer catch and surface as themselves.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp-server.js';

const TEST_CREDS = { publicKey: 'pk', secretKey: 'sk' };

function respond(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 401 ? 'Unauthorized' : '',
    headers: { 'content-type': 'application/json' },
  });
}

async function connectClient(): Promise<Client> {
  const server = createMcpServer(TEST_CREDS);
  const client = new Client({ name: 'customer-resolution-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function callTool(name: string, args: Record<string, unknown>) {
  const client = await connectClient();
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text?: string }>;
  };
}

describe('resolveSaasCustomerId propagates real errors from listDomains', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('surfaces a 401 from /v1/saas/domains, not "saasCustomerId is required"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(401)));
    const result = await callTool('datto_saas_list_seats', {});

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('401');
    expect(text).not.toContain('saasCustomerId is required');
  });
});
