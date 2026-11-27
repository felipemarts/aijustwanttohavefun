import { ref } from '@ajwf/shared';
import { addGold, bump, canFit, derive } from '../agent';
import { BALANCE, isNight, stealChance } from '../balance';
import { raiseBond } from '../bond';
import { isMayor } from '../election';
import { goodsValue, goodsView, isEmpty, missingGoods, parseGoods, putGoods, takeGoods } from '../goods';
import { checkPvpPair, isLawless } from '../pvp';
import { emit, fail, markAgent, msg, tell, type Run } from '../run';
import { addBounty, addHonor, bountyHasRoom, infamyNow, raiseInfamy } from '../trust';
import type { AgentState } from '../types';
import { VILLAGE_ID } from '../village-state';
import { agentByName, agentHere, type HandlerMap } from './util';

/**
 * Trust actions (PLANEJAMENTO §7): gifts on trust and scam reports, bounties, and theft. PvP itself goes through
 * `attack` and `cast` (pvp.ts).
 */

/** Rogues may pick pockets in lawless rooms at any hour, and in the village at night. */
function canStealHere(run: Run, a: AgentState): boolean {
  return isLawless(run, a.room) || (run.c.rooms.get(a.room)?.zone === 'village' && isNight(run.now));
}

/** Who a bounty can be placed on: someone with Infamy, and room on the list for a new contributor. */
function bountyTarget(run: Run, a: AgentState, name: string, payer: string): AgentState {
  const b = agentByName(run, name);
  if (!b) fail('TARGET_NOT_FOUND', 'agent_unknown', { name });
  if (b === a) fail('INVALID_PARAMS', 'bounty_self');
  if (!(infamyNow(b, run.now) > 0)) fail('NOT_ALLOWED', 'bounty_no_infamy', { name: b.name });
  if (!bountyHasRoom(run.s, b, payer)) fail('CONFLICT', 'bounty_full', { name: b.name, max: BALANCE.bounty.maxContributors });
  return b;
}

function announceBounty(run: Run, a: AgentState, b: AgentState, by: string, gold: number, total: number): void {
  emit(run, 'bounty_placed', {
    room: a.room,
    actor: a.id,
    target: b.id,
    vis: 'public',
    to: [b.id],
    drama: 6,
    m: msg(by === VILLAGE_ID ? 'ev.bounty_placed_village' : 'ev.bounty_placed', { actor: a.name, name: b.name, gold, total }),
    data: { by, target: b.name, gold, total, ...(by === VILLAGE_ID ? { mayor: a.name } : {}) },
  });
}

export const trustActions: HandlerMap = {
  give(run, a, p) {
    const b = agentHere(run, a, p.to);
    if (b === a) fail('INVALID_PARAMS', 'not_yourself_social');
    const goods = parseGoods(run, p);
    if (isEmpty(goods)) fail('INVALID_PARAMS', 'goods_empty');
    const missing = missingGoods(a, goods);
    if (missing.length) fail('MISSING_ITEMS', 'goods_missing', { missing: missing.join(', ') });
    if (!canFit(run.c, b, goods.items)) fail('INVENTORY_FULL', 'inventory_full_other', { name: b.name });
    takeGoods(a, goods);
    putGoods(run, b, goods);
    markAgent(run.s, b);
    const value = goodsValue(run, goods);
    const ev = emit(run, 'give', {
      room: a.room,
      actor: a.id,
      target: b.id,
      to: 'room',
      drama: value >= 200 ? 3 : 1,
      m: msg('ev.give', { actor: a.name, name: b.name, value }),
      data: { from: a.name, to: b.name, ...goodsView(goods), value },
    });
    // Keep the gift on record for report_scam: only recent ones, a bounded number of them.
    const G = BALANCE.give;
    a.gives = [...(a.gives ?? []).filter((x) => run.now - x.at <= G.reportWindowMs), { id: ev.id, to: b.id, value, at: run.now }].slice(-G.kept);
    raiseBond(run, a, b, G.bond);
    bump(run, a, 'gives');
    run.data.event_id = ev.id;
    tell(run, 'n.give', { name: b.name, value, event: ev.id, hours: G.reportWindowMs / 3_600_000 });
  },

  report_scam(run, a, p) {
    const b = agentByName(run, p.agent);
    if (!b) fail('TARGET_NOT_FOUND', 'agent_unknown', { name: p.agent });
    const id = p.event_id.trim().replace(/^#/, '');
    const g = (a.gives ?? []).find((x) => x.id === id);
    const hours = BALANCE.give.reportWindowMs / 3_600_000;
    if (!g) fail('TARGET_NOT_FOUND', 'scam_no_give', { event: id, hours });
    if (g.to !== b.id) fail('NOT_ALLOWED', 'scam_wrong_agent', { event: id, name: b.name });
    if (run.now - g.at > BALANCE.give.reportWindowMs) fail('NOT_ALLOWED', 'scam_too_late', { event: id, hours });
    if (g.reported) fail('CONFLICT', 'scam_already_reported', { event: id });
    g.reported = true;
    bump(run, a, 'scams_suffered');
    bump(run, b, 'scams_reported');
    // An honest-merchant streak does not survive a scam report.
    b.stats.clean_trades = 0;
    addHonor(run, b, BALANCE.honor.scam);
    markAgent(run.s, b);
    tell(run, 'n.report_scam', { name: b.name, value: g.value });
    emit(run, 'scam_reported', {
      room: a.room,
      actor: a.id,
      target: b.id,
      vis: 'public',
      to: [b.id],
      drama: 5,
      m: msg('ev.scam_reported', { actor: a.name, name: b.name, value: g.value }),
      data: { victim: a.name, accused: b.name, value: g.value, event: g.id },
    });
  },

  place_bounty(run, a, p) {
    const b = bountyTarget(run, a, p.agent, a.id);
    if (a.gold < p.gold) fail('NOT_ENOUGH_GOLD', 'no_gold', { need: p.gold, have: a.gold });
    a.gold -= p.gold;
    const pool = addBounty(run, b, { id: a.id, name: a.name }, p.gold);
    bump(run, a, 'bounties_placed');
    tell(run, 'n.place_bounty', { name: b.name, gold: p.gold, total: pool.total });
    announceBounty(run, a, b, a.name, p.gold, pool.total);
  },

  mayor_bounty(run, a, p) {
    if (!isMayor(run.s, a)) fail('NOT_ALLOWED', 'not_mayor', { name: run.s.village.mayor?.name ?? '' });
    const b = bountyTarget(run, a, p.agent, VILLAGE_ID);
    const v = run.s.village;
    if (v.treasury < p.gold) fail('NOT_ENOUGH_GOLD', 'treasury_lacks', { need: p.gold, have: v.treasury });
    v.treasury -= p.gold;
    run.s.dirty.add('village');
    const pool = addBounty(run, b, { id: VILLAGE_ID, name: null }, p.gold);
    tell(run, 'n.mayor_bounty', { name: b.name, gold: p.gold, total: pool.total, left: v.treasury });
    announceBounty(run, a, b, VILLAGE_ID, p.gold, pool.total);
  },

  steal(run, a, p) {
    if (a.cls !== 'rogue') fail('CLASS_REQUIRED', 'class_only', { class: ref.cls('rogue') });
    const b = agentHere(run, a, p.target);
    // Newcomers are protected from theft exactly as from PvP.
    checkPvpPair(run, a, b, canStealHere(run, a), true);
    const key = `steal:${b.id}`;
    const ready = a.cooldowns[key] ?? 0;
    if (ready > run.now) fail('COOLDOWN', 'steal_cooldown', { name: b.name, minutes: Math.ceil((ready - run.now) / 60_000) });
    const S = BALANCE.steal;
    // Expired per-target cooldowns are dropped, so the list stays as short as the targets of the last hours.
    for (const k of Object.keys(a.cooldowns)) if (k.startsWith('steal:') && a.cooldowns[k]! <= run.now) delete a.cooldowns[k];
    a.cooldowns[key] = run.now + S.cooldownMs;
    const chance = stealChance(derive(run.c, a, run.now).agi, b.level);
    if (run.rng.chance(chance)) {
      const gold = Math.floor(b.gold * S.maxShare * run.rng.range(S.minShare / S.maxShare, 1));
      b.gold -= gold;
      addGold(run, a, gold);
      markAgent(run.s, b);
      bump(run, a, 'steals');
      addHonor(run, a, BALANCE.honor.steal);
      tell(run, gold > 0 ? 'n.steal' : 'n.steal_empty', { name: b.name, gold });
      // Everyone in the room may notice, except the victim: it is never told.
      const witnesses = [...(run.s.roomAgents.get(a.room) ?? [])].filter((id) => id !== b.id);
      emit(run, 'steal', {
        room: a.room,
        actor: a.id,
        target: b.id,
        to: witnesses,
        drama: 5,
        m: msg('ev.steal', { actor: a.name, name: b.name, gold }),
        data: { thief: a.name, victim: b.name, gold },
      });
      return;
    }
    bump(run, a, 'steals_failed');
    raiseInfamy(run, a, BALANCE.infamy.stealFailed);
    tell(run, 'n.steal_failed', { name: b.name });
    emit(run, 'steal_failed', {
      room: a.room,
      actor: a.id,
      target: b.id,
      to: 'room',
      drama: 4,
      m: msg('ev.steal_failed', { actor: a.name, name: b.name }),
      data: { thief: a.name, victim: b.name },
    });
  },
};
