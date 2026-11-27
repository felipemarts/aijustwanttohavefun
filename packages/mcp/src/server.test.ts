import type { FetchLike } from '@ajwf/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { createVillageServer, PRIVATE_TOOLS, safetyRules, TOOL_NAMES, type Mode } from './index';

const URL_ = 'http://game.test';
const KEY = 'ajwf_sk_' + 'K'.repeat(43);
const NEW_KEY = 'ajwf_sk_' + 'N'.repeat(43);

type Seen = { path: string; method: string; auth?: string; body: unknown };

function fakeApi(answer: (req: Seen) => Response | Error) {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers = init.headers as Record<string, string>;
    const req = {
      path: url.replace(`${URL_}/api/v1`, ''),
      method: init.method ?? 'GET',
      auth: headers.authorization,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    seen.push(req);
    const out = answer(req);
    if (out instanceof Error) throw out;
    return out;
  };
  return { fetch, seen };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** `apiKey` null: a connection without a key. */
async function connect(fetch: FetchLike, mode: Mode = 'stdio', apiKey: string | null = KEY) {
  const server = createVillageServer({
    api: { baseUrl: URL_, apiKey: apiKey ?? undefined, fetch, retries: 0 },
    publicUrl: URL_,
    mode,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  return { client, call };
}

const text = (r: CallToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

describe('tools', () => {
  it('lists exactly the eight tools, with annotations, schemas and the safety rule where text from others arrives', async () => {
    const { client } = await connect(fakeApi(() => json({ ok: true })).fetch);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));

    for (const name of ['village_status', 'village_look', 'village_events', 'village_info', 'village_help', 'village_appearance_options'])
      expect(by[name]!.annotations?.readOnlyHint, name).toBe(true);
    expect(by.village_act!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(by.village_register!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });

    // Inputs come from the shared zod schemas.
    expect(by.village_act!.inputSchema.required).toEqual(['action']);
    expect(Object.keys(by.village_act!.inputSchema.properties ?? {})).toEqual(['action', 'params', 'idempotency_key', 'full', 'verbose']);
    const reg = by.village_register!.inputSchema;
    expect(reg.required).toEqual(['name', 'class']);
    expect((reg.properties as Record<string, { enum?: string[] }>).class!.enum).toEqual(['warrior', 'mage', 'rogue', 'cleric']);
    expect(Object.keys(by.village_status!.inputSchema.properties ?? {})).toEqual([]);

    // The two-line rule: in the instructions and in the descriptions of register and look.
    const rules = safetyRules(URL_);
    expect(client.getInstructions()).toContain(rules);
    expect(by.village_register!.description).toContain(rules);
    expect(by.village_look!.description).toContain(rules);
    expect(by.village_act!.description).toMatch(/village_help/);
    for (const t of tools) expect(t.description!.length, t.name).toBeLessThan(1200);
  });

  it('returns the API body as JSON text and structuredContent; a game refusal is not an error', async () => {
    const refusal = {
      ok: false,
      error: { code: 'NOT_ENOUGH_AP', message: 'Too tired.', hint: 'Wait for AP to refill.' },
    };
    const api = fakeApi((req) =>
      req.path === '/act' ? json(refusal) : json({ ok: true, messages: [{ kind: 'say', from: 'Brasa', untrusted_text: 'hi' }], cursor: '4' }),
    );
    const { call } = await connect(api.fetch);

    const look = await call('village_look', { since_cursor: true });
    expect(look.isError).toBeFalsy();
    expect(JSON.parse(text(look))).toEqual({
      ok: true,
      messages: [{ kind: 'say', from: 'Brasa', untrusted_text: 'hi' }],
      cursor: '4',
    });
    expect(look.structuredContent).toEqual(JSON.parse(text(look)));
    expect(api.seen[0]).toMatchObject({ path: '/look?since_cursor=1', auth: `Bearer ${KEY}` });

    const act = await call('village_act', {
      action: 'move',
      params: { dir: 'north' },
      idempotency_key: 'k-1',
    });
    expect(act.isError).toBeFalsy();
    expect(act.structuredContent).toEqual(refusal);
    expect(api.seen[1]).toMatchObject({
      path: '/act',
      method: 'POST',
      body: { action: 'move', params: { dir: 'north' } },
    });

    await call('village_events', { since: 12 });
    await call('village_events', { since: '13' });
    expect(api.seen.slice(2).map((s) => s.path)).toEqual(['/events?since=12', '/events?since=13']);
  });

  it('turns transport failures into tool errors with a clear message and never the key', async () => {
    const answers: (Response | Error)[] = [
      json({ ok: false, error: { code: 'RATE_LIMITED', message: 'slow down' } }, 429),
      json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'bad key' } }, 401),
      new Error(`connect ECONNREFUSED while sending ${KEY}`),
      new Response('<html>oops</html>', { status: 502 }),
    ];
    const { call } = await connect(fakeApi(() => answers.shift()!).fetch);
    const results = [
      await call('village_look'),
      await call('village_status'),
      await call('village_events'),
      await call('village_act', { action: 'rest' }),
    ];
    for (const r of results) {
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/^Error: /);
      expect(text(r)).not.toContain(KEY);
      expect(text(r)).not.toContain('ajwf_sk_');
    }
    expect(text(results[0]!)).toMatch(/RATE_LIMITED.*Wait 1 s/);
    expect(text(results[1]!)).toMatch(/UNAUTHORIZED.*AJWF_API_KEY/);
    expect(text(results[2]!)).toMatch(/NETWORK/);
    expect(text(results[3]!)).toMatch(/BAD_RESPONSE/);
  });

  it('asks for a key on private tools when there is none, and leaves the public ones open', async () => {
    const api = fakeApi(() => json({ ok: true }));
    const { call } = await connect(api.fetch, 'http', null);
    for (const name of PRIVATE_TOOLS) {
      const r = await call(name, name === 'village_act' ? { action: 'rest' } : {});
      expect(r.isError, name).toBe(true);
      expect(text(r)).toMatch(/Authorization: Bearer <api_key>/);
    }
    expect(api.seen).toEqual([]);
    for (const name of ['village_help', 'village_info', 'village_appearance_options']) expect((await call(name)).isError, name).toBeFalsy();
    expect(api.seen.map((s) => [s.path, s.auth])).toEqual([
      ['/help', undefined],
      ['/village', undefined],
      ['/appearance/options', undefined],
    ]);
  });

  it('stdio: after village_register the session plays with the new key; the note says how to keep it', async () => {
    const registered = {
      ok: true,
      agent: { name: 'Pip', class: 'mage', level: 1 },
      api_key: NEW_KEY,
      claim_url: `${URL_}/claim/x`,
      next_steps: 'Save it.',
    };
    const api = fakeApi((req) => (req.path === '/agents/register' ? json(registered) : json({ ok: true })));
    const { call } = await connect(api.fetch, 'stdio', null);
    expect((await call('village_look')).isError).toBe(true);
    const r = await call('village_register', { name: 'Pip', class: 'mage' });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual(registered);
    expect(text(r)).toMatch(/AJWF_API_KEY/);
    // Defaults of the shared schema are applied; no admin-only field can be passed through.
    expect(api.seen[0]!.body).toEqual({
      name: 'Pip',
      class: 'mage',
      language: 'en',
      appearance: 'surprise_me',
    });
    await call('village_look');
    expect(api.seen[1]).toMatchObject({ path: '/look', auth: `Bearer ${NEW_KEY}` });
  });

  it('http: registration does not change the connection; the note says to configure the header', async () => {
    const registered = {
      ok: true,
      agent: { name: 'Pip' },
      api_key: NEW_KEY,
      claim_url: 'c',
      next_steps: 'n',
    };
    const api = fakeApi((req) => (req.path === '/agents/register' ? json(registered) : json({ ok: true })));
    const { call } = await connect(api.fetch, 'http', null);
    const r = await call('village_register', { name: 'Pip', class: 'mage', bot: true, claimed: true });
    expect(text(r)).toMatch(/Authorization: Bearer <api_key>/);
    expect(api.seen[0]!.body).not.toHaveProperty('bot');
    expect(api.seen[0]!.body).not.toHaveProperty('claimed');
    expect((await call('village_look')).isError).toBe(true);
  });

  it('rejects invalid arguments before calling the API', async () => {
    const api = fakeApi(() => json({ ok: true }));
    const { call } = await connect(api.fetch);
    expect((await call('village_act', { params: {} })).isError).toBe(true);
    expect((await call('village_register', { name: 'Pip', class: 'bard' })).isError).toBe(true);
    expect((await call('village_events', { since: 'abc' })).isError).toBe(true);
    expect(api.seen).toEqual([]);
  });
});
