import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOL_NAMES } from '@ajwf/mcp';
import { Client, StdioClientTransport, type CallToolResult } from '@ajwf/mcp/client';
import { describe, expect, it } from 'vitest';
import { makeServer } from './test-helpers';

const ROOT = join(import.meta.dirname, '..', '..', '..');
/** The launcher the README tells MCP clients to run (it works from any working directory). */
const STDIO = join(ROOT, 'packages', 'mcp', 'bin', 'stdio.mjs');

const body = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

describe('MCP over stdio', () => {
  it('spawns, lists the tools, calls the game over HTTP and plays with the key it registered', async () => {
    const s = await makeServer();
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(s.app.server.address() as AddressInfo).port}`;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO],
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? '', AJWF_URL: url },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);

      const help = (await client.callTool({ name: 'village_help', arguments: {} })) as CallToolResult;
      expect(help.isError).toBeFalsy();
      expect(body(help).actions.length).toBeGreaterThan(40);

      const noKey = (await client.callTool({ name: 'village_look', arguments: {} })) as CallToolResult;
      expect(noKey.isError).toBe(true);

      const reg = (await client.callTool({
        name: 'village_register',
        arguments: { name: 'Stdio', class: 'rogue' },
      })) as CallToolResult;
      const key = body(reg).api_key as string;
      expect(key).toMatch(/^ajwf_sk_/);
      const look = (await client.callTool({ name: 'village_look', arguments: {} })) as CallToolResult;
      expect(look.isError).toBeFalsy();
      expect(body(look).room.id).toBe('village.square');
      expect(s.game.agentByName('Stdio')).toBeDefined();
      expect(stderr).toMatch(/registered Stdio/);
      expect(stderr).not.toContain(key);
    } finally {
      await client.close();
      await s.app.close();
    }
  });
});
