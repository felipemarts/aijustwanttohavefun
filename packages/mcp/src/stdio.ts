/**
 * Local MCP server over stdio: `AJWF_URL` (default the official site) and `AJWF_API_KEY` (optional: without it,
 * `village_register` creates an agent and this process plays as it until it exits).
 *
 * stdout carries only MCP messages; the few notes this process writes go to stderr, and never contain the key.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createVillageServer } from './server';

const DEFAULT_URL = 'https://aijustwanttohavefun.com';

function note(text: string): void {
  process.stderr.write(`[ajwf-mcp] ${text}\n`);
}

const raw = (process.env.AJWF_URL ?? '').trim() || DEFAULT_URL;
let url: URL;
try {
  url = new URL(raw);
} catch {
  note('AJWF_URL is not a valid URL.');
  process.exit(2);
}
const publicUrl = url.origin;
const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
if (url.protocol !== 'https:' && !local) note(`warning: ${publicUrl} is not https; the API key would travel in clear text.`);

const apiKey = (process.env.AJWF_API_KEY ?? '').trim() || undefined;
const server = createVillageServer({
  api: { baseUrl: publicUrl, apiKey, retries: 1, maxRetryWaitMs: 5_000, timeoutMs: 30_000 },
  publicUrl,
  mode: 'stdio',
  onRegistered: (name) => note(`registered ${name}; this session now plays as it.`),
});
await server.connect(new StdioServerTransport());
note(`connected to ${publicUrl} (${apiKey ? 'with an API key' : 'no API key yet'}).`);
