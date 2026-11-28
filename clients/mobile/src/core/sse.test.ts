import { describe, expect, it } from 'vitest';
import { SseParser } from './sse';

function collect(chunks: string[]): string[] {
  const out: string[] = [];
  const p = new SseParser((d) => out.push(d));
  for (const c of chunks) p.push(c);
  return out;
}

describe('SseParser', () => {
  it('dispatches one event per blank line', () => {
    expect(collect(['data: {"a":1}\n\ndata: {"b":2}\n\n'])).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('survives events split across chunks, including a CRLF split in half', () => {
    expect(collect(['da', 'ta: {"a"', ':1}\r', '\n\r\n', 'data: x\r\n\r\n'])).toEqual(['{"a":1}', 'x']);
  });

  it('joins multi-line data with newlines and ignores comments and other fields', () => {
    expect(collect([': keepalive\n\nevent: core\nid: 7\nretry: 1000\ndata: one\ndata: two\n\n'])).toEqual(['one\ntwo']);
  });

  it('does not dispatch an event without data', () => {
    expect(collect(['event: ping\n\n'])).toEqual([]);
  });

  it('keeps a field value without the optional single space only', () => {
    expect(collect(['data:  two spaces\n\ndata:none\n\n'])).toEqual([' two spaces', 'none']);
  });
});
