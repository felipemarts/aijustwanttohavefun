import type { GameEvent, RoomFull } from '@ajwf/shared';
import { describe, expect, it } from 'vitest';
import { createI18n, loadCatalogs } from './i18n';
import { momentsOf } from './owner/push';
import { makeServer } from './test-helpers';

const WISH = 'I hope Mira finally notices me';

describe('a wish at the fountain', () => {
  it('reaches the agents in the room without its words, while spectators read them in the room feed', async () => {
    const s = await makeServer();
    const pip = await s.register('Pip');
    const mira = await s.register('Mira');
    const brasa = await s.register('Brasa');
    // Pip reads with /events, Mira with /look: the arrivals are out of the way first.
    const cursor = (await s.get(pip.key, '/api/v1/events?since=0')).json().cursor as string;
    await s.get(mira.key, '/api/v1/look');

    const res = await s.act(brasa.key, 'wish', { gold: 2, text: WISH });
    expect(res.json().ok).toBe(true);
    expect(res.body).not.toContain(WISH);

    const events = await s.get(pip.key, `/api/v1/events?since=${cursor}`);
    const wish = (events.json().events as { kind: string; text?: string }[]).find((e) => e.kind === 'wish');
    expect(wish?.text).toBe('Brasa tosses a coin into the fountain and makes a silent wish.');
    expect(events.body).not.toContain(WISH);
    expect(events.body).not.toContain('untrusted_text');

    const look = await s.get(mira.key, '/api/v1/look');
    expect((look.json().messages as { kind: string }[]).map((m) => m.kind)).toContain('wish');
    expect(look.body).not.toContain(WISH);

    const room = (await s.app.inject({ method: 'GET', url: '/api/public/rooms/village.square' })).json() as RoomFull;
    const seen = room.log.find((e) => e.type === 'wish');
    expect(seen).toMatchObject({ actor: 'Brasa', text: WISH, lang: 'en', k: 'ev.wish', p: { actor: 'Brasa' } });
  });

  it('a jackpot is a moment worth a push to the winner’s owner', async () => {
    const s = await makeServer();
    await s.register('Pip');
    const a = s.game.agentByName('Pip')!;
    const ev: GameEvent = { id: '9', ts: 0, type: 'fountain_jackpot', actor: a.id, roomId: 'village.square', visibility: 'public', payload: { gold: 42 } };
    const moments = momentsOf(ev, s.game.state, () => true);
    expect(moments).toEqual([{ type: 'jackpot', agentId: a.id, params: { name: 'Pip', gold: 42 } }]);
    const i18n = createI18n(loadCatalogs(), () => undefined);
    expect(i18n.t('en', 'owner.push.jackpot.title', moments[0]!.params)).toBe('Pip hit the fountain jackpot!');
    expect(i18n.t('en', 'owner.push.jackpot.body', moments[0]!.params)).toContain('42 gold');
  });
});
