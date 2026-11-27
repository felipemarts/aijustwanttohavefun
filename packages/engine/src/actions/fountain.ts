import { MAX_WISH_LEN, own, ref } from '@ajwf/shared';
import { addGold, bump, takeGold } from '../agent';
import { BALANCE } from '../balance';
import { covers, creditPot, debitPot } from '../ledger';
import { emit, fail, msg, tell, type Run } from '../run';
import { cleanText, hasFlag, wholeNumber, type HandlerMap } from './util';

/** Where a fountain stands, for the hint of an agent wishing elsewhere: the first room that has one. */
function fountainRoom(run: Run): string {
  for (const r of run.c.rooms.values()) if (r.flags.includes('fountain')) return r.id;
  return BALANCE.startRoom;
}

/**
 * The wishing fountain: coins tossed in stay there, in a pot that is world state. Agents in the room see that a wish
 * was made, never its text, which only spectators read (`SPECTATOR_TEXT_EVENT_TYPES`). Once the pot is large enough,
 * a toss may give the whole pot back to the one who made it; nothing told to agents says so.
 */
export const fountainActions: HandlerMap = {
  wish(run, a, p) {
    const F = BALANCE.fountain;
    if (!hasFlag(run, a, 'fountain')) fail('NOT_AVAILABLE_HERE', 'no_fountain', { room: ref.room(fountainRoom(run)) });
    // The schema defaults `gold` to 1; a caller that skips it (applyParsed) may leave it out.
    const gold = wholeNumber((p.gold as number | undefined) ?? 1, 'gold', 1);
    if (gold > F.maxCoins) fail('INVALID_PARAMS', 'wish_gold', { max: F.maxCoins });
    if (!covers(a.gold, gold)) fail('NOT_ENOUGH_GOLD', 'no_gold', { need: gold, have: a.gold });
    // The wish is agent text: the cooldown is checked first, then the text is cleaned, then the cooldown starts,
    // so a refused wish changes nothing and costs the server as little as possible.
    const readyAt = own(a.cooldowns, 'wish') ?? 0;
    if (readyAt > run.now) fail('COOLDOWN', 'wish_cooldown', { seconds: Math.ceil((readyAt - run.now) / 1000) });
    let text: string | null = null;
    if (p.text !== undefined) {
      // A muted agent may still toss a coin, but not have its words shown.
      if (a.mutedUntil > run.now) fail('MUTED', 'muted', { minutes: Math.ceil((a.mutedUntil - run.now) / 60_000) });
      text = cleanText(p.text, MAX_WISH_LEN);
    }
    a.cooldowns.wish = run.now + F.cooldownMs;

    const fountain = run.s.fountain;
    const before = fountain.pot;
    takeGold(a, gold);
    creditPot(fountain, gold, 'fountain pot');
    run.s.dirty.add('fountain');
    tell(run, 'n.wish', { gold, pot: fountain.pot });
    emit(run, 'wish', {
      room: a.room,
      actor: a.id,
      to: 'room',
      drama: 1,
      m: msg('ev.wish', { actor: a.name }),
      ...(text !== null ? { lang: a.lang, data: { text } } : {}),
    });
    bump(run, a, 'wishes');

    // Linear in the coins tossed (capped at certainty), so splitting a toss gains nothing. One roll, only once the
    // pot held enough before this toss.
    // The roll pays other players' gold, so it comes from `luck` (unpredictable on the server) when there is one.
    const chance = Math.min(1, gold * F.chancePerCoin);
    if (!(before >= F.minPot && (run.luck ? run.luck() < chance : run.rng.chance(chance)))) return;
    const won = fountain.pot;
    debitPot(fountain, won, 'fountain pot');
    addGold(run, a, won);
    tell(run, 'n.wish_jackpot', { gold: won });
    emit(run, 'fountain_jackpot', {
      room: a.room,
      actor: a.id,
      vis: 'public',
      to: 'room',
      drama: 9,
      m: msg('ev.fountain_jackpot', { actor: a.name, gold: won, room: ref.room(a.room) }),
      data: { gold: won },
    });
    bump(run, a, 'jackpots');
  },
};
