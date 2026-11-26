import { eventsSince, type WorldState } from '@ajwf/engine';
import { hashString, type GameEvent } from '@ajwf/shared';

/** Top-level parts of an observation that can be left out when the agent already has them (§13.3). */
export type Part = 'narration' | 'you' | 'room' | 'actions' | 'time' | 'quest' | 'pending' | 'boss';

/** Inbox events delivered inline with `/look` and `/act`; the rest waits for the next call or `GET /events`. */
export const MESSAGES_PER_RESPONSE = 10;

type View = { shown: number; sent: Partial<Record<Part, string>> };

/**
 * What each agent was last sent, so responses carry only what is new: the inbox position already shown and a
 * hash of every part. In memory only: after a restart the first response is simply complete again.
 */
export class AgentViews {
  private views = new Map<string, View>();

  constructor(private state: WorldState) {}

  private view(agentId: string): View {
    let v = this.views.get(agentId);
    if (!v) this.views.set(agentId, (v = { shown: 0, sent: {} }));
    return v;
  }

  /** Inbox events not yet shown to the agent (oldest first), marking them as shown. */
  takeMessages(agentId: string): { events: GameEvent[]; cursor: number } {
    const v = this.view(agentId);
    const page = eventsSince(this.state, agentId, v.shown, MESSAGES_PER_RESPONSE);
    v.shown = Math.max(v.shown, page.cursor);
    return page;
  }

  shown(agentId: string): number {
    return this.view(agentId).shown;
  }

  markShown(agentId: string, cursor: number): void {
    const v = this.view(agentId);
    v.shown = Math.max(v.shown, cursor);
  }

  /** Records that `value` was sent as `part` and tells whether it differs from what was sent before. */
  changed(agentId: string, part: Part, value: unknown): boolean {
    const v = this.view(agentId);
    const h = hashString(JSON.stringify(value) ?? '');
    const differs = v.sent[part] !== h;
    v.sent[part] = h;
    return differs;
  }
}
