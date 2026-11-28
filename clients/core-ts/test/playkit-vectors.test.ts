/**
 * The playkit's golden vectors, read from clients/playkit/vectors (no copies), compared as the Go test compares them:
 * canonical JSON (key order ignored) for everything, plus member order for `schema`.
 *
 * `PLAYKIT_DIR` points the test at another copy of the playkit folder. When the playkit on disk is a different
 * version from the one embedded in this port (src/playkit/kit-data.ts), its vectors cannot pass and are skipped with
 * a warning: run `npm run sync-playkit` and port the changes.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Playkit, chatInputFrom, chatLinesFrom, memoryFrom, memoryTo, recentFrom, turnInputFrom, worldFrom, worldTo, type Menu, type Message } from '../src/playkit/index.ts';
import { arr, canon, equal, formatNumber, get, num, obj, parse, quote, text, write, type JV } from '../src/playkit/jv.ts';
import { clip, oneLine, plain, quoted, render } from '../src/playkit/text.ts';
import { PLAYKIT_JSON, TEMPLATES } from '../src/playkit/kit-data.ts';

const dir = process.env.PLAYKIT_DIR ? pathToFileURL(`${resolvePath(process.env.PLAYKIT_DIR)}/`) : new URL('../../playkit/', import.meta.url);
const diskVersion = (JSON.parse(readFileSync(new URL('playkit.json', dir), 'utf8')) as { version: string }).version;
const load = (name: string): JV => parse(readFileSync(new URL(`vectors/${name}`, dir), 'utf8'));
const cases = (name: string): JV[] => arr(get(load(name), 'cases'));
const pk = new Playkit();
const doc = pk.parseSchemaDoc(readFileSync(new URL('vectors/schema.json', dir), 'utf8'));
const messagesValue = (msgs: Message[]): JV => msgs.map((m) => obj(['role', m.role], ['content', m.content]));

/** The Go test's `check`: canonical equality, and exact member order inside `schema`. */
function check(c: JV, got: JV, label: string): void {
  const want = get(c, 'expect');
  expect(want, `${label}: no expectation`).toBeDefined();
  if (canon(want!) !== canon(got)) {
    // Show the first differing message or field readably.
    expect(write(got), label).toBe(write(want!));
  }
  const gs = get(got, 'schema');
  if (gs !== undefined) expect(equal(get(want, 'schema'), gs), `${label}: schema member order`).toBe(true);
}

const sameVersion = diskVersion === new Playkit().version;
if (!sameVersion) console.warn(`playkit on disk is ${diskVersion}, this port is ${new Playkit().version}: its vectors are skipped (sync and port it)`);

describe.skipIf(!sameVersion)('playkit golden vectors', () => {
  const promptCases = cases('prompts.json');
  const menus: Menu[] = promptCases.map((c) => pk.buildTurn(doc, turnInputFrom(get(c, 'input')!)).menu);

  it.each(promptCases.map((c, i) => [text(get(c, 'name')), i] as const))('prompts: %s', (name, i) => {
    const c = promptCases[i]!;
    const turn = pk.buildTurn(doc, turnInputFrom(get(c, 'input')!));
    const got = obj(['messages', messagesValue(turn.messages)], ['menu', turn.menu.actions.map((a) => a.name)], ['schema', turn.menu.schema]);
    // Byte for byte on the prompt text first: the most useful failure.
    const want = get(c, 'expect');
    arr(get(want, 'messages')).forEach((m, k) => expect(turn.messages[k]?.content, `${name} message ${k}`).toBe(text(get(m, 'content'))));
    check(c, got, name);
  });

  const decisionCases = cases('decisions.json');
  it.each(decisionCases.map((c, i) => [text(get(c, 'name')), i] as const))('decisions: %s', async (name, i) => {
    const c = decisionCases[i]!;
    const menu = menus[num(get(c, 'menuFrom'))]!;
    const raw = text(get(c, 'raw'));
    const dv = (d: { thought: string; action: string; params: JV; note: string }) => obj(['thought', d.thought], ['action', d.action], ['params', d.params instanceof Map ? d.params : obj()], ['note', d.note]);
    const first = pk.decide(raw, menu);
    const got = obj(['first', 'decision' in first ? obj(['ok', true], ['decision', dv(first.decision)]) : obj(['ok', false], ['problem', first.problem])]);
    const retry = get(c, 'retry');
    if (retry !== undefined) {
      const problems: string[] = [];
      const res = await pk.resolve(menu, raw, async (problem) => {
        problems.push(problem);
        if (typeof retry !== 'string') throw new Error('engine error');
        return retry;
      });
      got.set('final', obj(['source', res.source], ['decision', res.source === 'none' || !res.decision ? null : dv(res.decision)]));
      if (problems.length === 1) {
        const msgs = pk.retryMessages([{ role: 'user', content: 'turn' }], raw, problems[0]!);
        got.set('retryMessage', msgs[msgs.length - 1]!.content);
      }
    }
    check(c, got, name);
  });

  const textCases = cases('text.json');
  it.each(textCases.map((c, i) => [`${text(get(c, 'fn'))} ${write(get(c, 'in') ?? null)}`, i] as const))('text: %s', (label, i) => {
    const c = textCases[i]!;
    const fn = text(get(c, 'fn'));
    const inp = get(c, 'in') ?? null;
    const n = num(get(c, 'n'));
    let got: string;
    switch (fn) {
      case 'oneLine':
        got = oneLine(text(inp));
        break;
      case 'clip':
        got = clip(text(inp), n);
        break;
      case 'plain':
        got = plain(text(inp), n);
        break;
      case 'quoted':
        got = quoted(text(inp), n);
        break;
      case 'quote':
        got = quote(text(inp));
        break;
      case 'render': {
        const vals: Record<string, string> = {};
        for (const [k, v] of get(c, 'vals') instanceof Map ? (get(c, 'vals') as Map<string, JV>) : []) vals[k] = text(v);
        got = render(text(get(c, 'tpl')), vals);
        break;
      }
      case 'number':
        got = formatNumber(num(inp));
        break;
      case 'canon':
        got = canon(inp);
        break;
      default:
        throw new Error(`unknown fn ${fn}`);
    }
    check(c, got, label);
  });

  const memoryCases = cases('memory.json');
  it.each(memoryCases.map((c, i) => [`${text(get(c, 'fn'))} ${text(get(c, 'name'))}`, i] as const))('memory: %s', (label, i) => {
    const c = memoryCases[i]!;
    switch (text(get(c, 'fn'))) {
      case 'remember': {
        const m = memoryFrom(get(c, 'memory'));
        const rv = get(c, 'recent');
        const compact = pk.remember(m, rv instanceof Map ? recentFrom(rv) : null, text(get(c, 'note')), chatLinesFrom(get(c, 'chat')));
        check(c, obj(['memory', memoryTo(m)], ['compact', compact]), label);
        break;
      }
      case 'observe': {
        const w = worldFrom(get(c, 'world'));
        pk.observe(w, get(c, 'observation') ?? null);
        check(c, obj(['world', worldTo(w)], ['path', pk.path(w, text(get(c, 'from')), text(get(c, 'to')))]), label);
        break;
      }
      case 'compaction': {
        const notes = arr(get(c, 'notes')).map((x) => text(x));
        const t = pk.compactionTurn(text(get(c, 'charName')), notes);
        check(c, obj(['messages', messagesValue(t.messages)], ['schema', t.schema], ['notes', pk.applyCompaction(text(get(c, 'raw')), notes)]), label);
        break;
      }
      default:
        throw new Error('unknown memory fn');
    }
  });

  const chatCases = cases('chat.json');
  it.each(chatCases.map((c, i) => [text(get(c, 'name')), i] as const))('chat: %s', (name, i) => {
    const c = chatCases[i]!;
    check(c, obj(['messages', messagesValue(pk.chatTurn(chatInputFrom(get(c, 'input')!)))]), name);
  });

  it('every vector file is covered', () => {
    const files = readdirSync(new URL('vectors/', dir)).sort();
    for (const f of ['chat.json', 'decisions.json', 'memory.json', 'prompts.json', 'schema.json', 'text.json']) expect(files).toContain(f);
    expect(promptCases.length + decisionCases.length + textCases.length + memoryCases.length + chatCases.length).toBeGreaterThan(70);
  });

  it('the embedded kit is the same as clients/playkit (run `npm run sync-playkit`)', () => {
    const lf = (s: string) => s.replace(/\r\n/g, '\n');
    expect(PLAYKIT_JSON).toBe(lf(readFileSync(new URL('playkit.json', dir), 'utf8')));
    const names = readdirSync(new URL('prompts/', dir)).filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4)).sort();
    expect(Object.keys(TEMPLATES).sort()).toEqual(names);
    for (const n of names) expect(TEMPLATES[n], n).toBe(lf(readFileSync(new URL(`prompts/${n}.txt`, dir), 'utf8')));
    expect(pk.version.startsWith('1.')).toBe(true);
  });
});
