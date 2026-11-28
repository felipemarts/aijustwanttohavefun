/**
 * A minimal Server-Sent Events parser. `EventSource` cannot send an `Authorization` header, so `RemoteCore` reads
 * `/core/events` with `fetch` and feeds the bytes here. Only `data:` matters to the contract; `event`, `id` and
 * `retry` fields and comments are accepted and ignored.
 */
export class SseParser {
  private buf = '';
  private data: string[] = [];
  private readonly onData: (data: string) => void;

  constructor(onData: (data: string) => void) {
    this.onData = onData;
  }

  push(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.search(/\r\n|\r|\n/);
      if (nl < 0) break;
      // A lone `\r` at the very end may be the first half of `\r\n`: wait for the next chunk.
      if (this.buf[nl] === '\r' && nl === this.buf.length - 1) break;
      const width = this.buf.startsWith('\r\n', nl) ? 2 : 1;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + width);
      this.line(line);
    }
    // Guard against a server that never sends a newline.
    if (this.buf.length > 1_000_000) this.buf = '';
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length > 0) {
        const payload = this.data.join('\n');
        this.data = [];
        this.onData(payload);
      }
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.data.push(value);
  }
}
