const PER_AGENT = 32;
const TTL_MS = 10 * 60_000;
export const MAX_IDEMPOTENCY_KEY_LEN = 128;

type Entry = { at: number; body: string };

/**
 * Remembers the last responses to `POST /act` per agent and `Idempotency-Key` (§11.6), so a retried call returns
 * the stored response instead of acting twice. Bounded: `PER_AGENT` keys per agent, each kept `TTL_MS`.
 */
export class IdempotencyCache {
  private byAgent = new Map<string, Map<string, Entry>>();
  private ops = 0;

  get(agentId: string, key: string, now: number): string | undefined {
    const e = this.byAgent.get(agentId)?.get(key);
    return e && now - e.at < TTL_MS ? e.body : undefined;
  }

  set(agentId: string, key: string, body: string, now: number): void {
    if (++this.ops % 1000 === 0) this.sweep(now);
    let m = this.byAgent.get(agentId);
    if (!m) this.byAgent.set(agentId, (m = new Map()));
    m.delete(key);
    m.set(key, { at: now, body });
    while (m.size > PER_AGENT) m.delete(m.keys().next().value!);
  }

  private sweep(now: number): void {
    for (const [agentId, m] of this.byAgent) {
      for (const [k, e] of m) if (now - e.at >= TTL_MS) m.delete(k);
      if (!m.size) this.byAgent.delete(agentId);
    }
  }
}
