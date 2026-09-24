/**
 * Guard: the activity-log tool and route must never come back.
 *
 * `datto_saas_list_activity` read Datto's partner-wide audit log — who on
 * our staff did what, from which IP, across every Datto product, not just
 * SaaS Protection. The owner does not want any MCP.Read holder able to see
 * that. This is one layer of the removal (the gateway denies the tool name
 * separately); this test pins that the server itself cannot reach it, by
 * name or by source text, even if someone re-adds a case in the handler
 * without re-adding a route.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp-server.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const TEST_CREDS = { publicKey: 'pk', secretKey: 'sk' };

async function connectClient(): Promise<Client> {
  const server = createMcpServer(TEST_CREDS);
  const client = new Client({ name: 'no-activity-log-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Strip `//` line comments and `/* … *‍/` blocks so a source-text check can't be fooled by a comment. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the activity-log tool and route stay gone', () => {
  it('registers no tool whose name mentions activity', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const offenders = tools.map((t) => t.name).filter((name) => name.includes('activity'));
    expect(offenders).toEqual([]);
  });

  it('has no reachable reference to the activity-log route in datto-api.ts', () => {
    const source = readFileSync(path.join(root, 'src', 'datto-api.ts'), 'utf8');
    const withoutComments = stripComments(source);
    expect(withoutComments).not.toContain('activity-log');
  });

  it('rejects a call to the removed tool as unknown', async () => {
    const client = await connectClient();
    const result = (await client.callTool({
      name: 'datto_saas_list_activity',
      arguments: {},
    })) as { isError?: boolean; content: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/unknown tool/i);
  });
});
