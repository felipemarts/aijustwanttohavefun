import type { Project } from '@ajwf/content';
import { hasOwnKey, MAX_PLATFORM_LEN, normalizeName, own, ref } from '@ajwf/shared';
import { addGold, bump } from '../agent';
import { covers, debitTreasury, stockTake } from '../ledger';
import { BALANCE } from '../balance';
import { isMayor } from '../election';
import { goodsView, isEmpty, missingGoods, parseGoods, takeGoods } from '../goods';
import { guildOf, markGuild } from '../guild';
import { questEvent } from '../quests';
import { emit, fail, markAgent, msg, tell, type Run } from '../run';
import { addHonor, contributionHonor } from '../trust';
import type { AgentState, Goods, Stack } from '../types';
import { deliver, hallCost, hallOf, missingFor, noteContributor, progressOf, projectAt, projectStatus, splitOffer, valueOf } from '../village';
import { cleanText, normId, wholeNumber, type HandlerMap } from './util';

/** A project by id ("bridge", "River Bridge" folded); refused when unknown. */
function projectById(run: Run, raw: string): Project {
  const p = run.c.projects.get(normId(raw));
  if (!p) fail('TARGET_NOT_FOUND', 'project_unknown', { project: raw });
  return p;
}

/** Only projects that can receive something: every requirement done, itself not done. */
function availableProject(run: Run, raw: string): Project {
  const p = projectById(run, raw);
  const status = projectStatus(run.s, p);
  if (status === 'done') fail('CONFLICT', 'project_done', { proj: ref.proj(p.id) });
  if (status === 'locked') {
    const other = p.requires.find((r) => projectStatus(run.s, run.c.projects.get(r)!) !== 'done')!;
    fail('NOT_ALLOWED', 'project_locked', { proj: ref.proj(p.id), other: ref.proj(other) });
  }
  return p;
}

function mayorOnly(run: Run, a: AgentState): void {
  if (!isMayor(run.s, a)) {
    const m = run.s.village.mayor;
    fail('NOT_ALLOWED', 'not_mayor', { name: m?.name ?? '' });
  }
}

/** "wood x3, stone x2" for narration. */
function listGoods(g: Goods): string {
  return [...(g.gold > 0 ? [`gold x${g.gold}`] : []), ...g.items.map((x) => `${x.item} x${x.qty}`)].join(', ');
}

const pct = (rate: number) => Math.round(rate * 1000) / 10;

export const civicActions: HandlerMap = {
  contribute(run, a, p) {
    const proj = availableProject(run, p.project);
    const room = run.c.rooms.get(a.room)!;
    if (!room.flags.includes('town_hall') && a.room !== proj.site) {
      fail('NOT_AVAILABLE_HERE', 'contribute_place', { proj: ref.proj(proj.id), room: ref.room(proj.site), site: proj.site });
    }
    const offer = parseGoods(run, p);
    if (isEmpty(offer)) fail('INVALID_PARAMS', 'goods_empty');
    if (!covers(a.gold, offer.gold)) fail('NOT_ENOUGH_GOLD', 'no_gold', { need: offer.gold, have: a.gold });
    const lacks = missingGoods(a, offer);
    if (lacks.length) fail('MISSING_ITEMS', 'goods_missing', { missing: lacks.join(', ') });

    // Trim to what the project still needs: nothing beyond it is ever taken.
    const need = missingFor(run.s, proj);
    const bonusPct = run.s.village.priority === proj.id ? BALANCE.village.priorityBonusPct : 0;
    const g = splitOffer(offer.gold, need.gold, bonusPct);
    const given: Goods = { gold: g.take, items: [] };
    const bonus: Goods = { gold: g.bonus, items: [] };
    for (const x of offer.items) {
      const short = need.items.find((n) => n.item === x.item)?.qty ?? 0;
      const it = splitOffer(x.qty, short, bonusPct);
      if (it.take > 0) given.items.push({ item: x.item, qty: it.take });
      if (it.bonus > 0) bonus.items.push({ item: x.item, qty: it.bonus });
    }
    if (isEmpty(given)) fail('CONFLICT', 'project_not_needed', { proj: ref.proj(proj.id), missing: listGoods(need) });

    takeGoods(a, given);
    const first = !hasOwnKey(own(run.s.village.projects, proj.id)?.by, a.id);
    const value = valueOf(run.c, given);
    const kept: Stack[] = offer.items.map((x) => ({ item: x.item, qty: x.qty - (given.items.find((y) => y.item === x.item)?.qty ?? 0) })).filter((x) => x.qty > 0);
    const keptGold = offer.gold - given.gold;
    // Counted before delivery, so the gift that completes the statue counts for its honoree.
    bump(run, a, 'contributions', value);
    if (first) bump(run, a, 'projects_contributed');
    addHonor(run, a, contributionHonor(value));
    noteContributor(run.s, a);
    deliver(run, proj, a, given, bonus);
    questEvent(run, a, 'contribute', proj.id);

    const done = projectStatus(run.s, proj) === 'done';
    const progress = progressOf(run.s, proj);
    run.data.contribution = { project: proj.id, ...goodsView(given), ...(isEmpty(bonus) ? {} : { bonus: goodsView(bonus) }), progress };
    tell(run, 'n.contribute', { proj: ref.proj(proj.id), goods: listGoods(given), pct: Math.round(progress * 100) });
    if (!isEmpty(bonus)) tell(run, 'n.contribute_bonus', { goods: listGoods(bonus) });
    if (keptGold > 0 || kept.length) tell(run, 'n.contribute_trimmed', { goods: listGoods({ gold: keptGold, items: kept }) });
    if (done) tell(run, 'n.project_done', { proj: ref.proj(proj.id) });

    // Honour, not spam: big gifts are always public; small ones at most once per agent per interval.
    const V = BALANCE.village;
    const loud = value >= V.announceValue || (own(a.cooldowns, 'contrib_ev') ?? 0) <= run.now;
    if (loud) a.cooldowns.contrib_ev = run.now + V.announceEveryMs;
    emit(run, 'project_contribution', {
      room: a.room,
      actor: a.id,
      vis: loud ? 'public' : 'room',
      drama: 1,
      m: msg('ev.project_contribution', { actor: a.name, proj: ref.proj(proj.id), value }),
      data: { project: proj.id, ...goodsView(given), value, ...(isEmpty(bonus) ? {} : { bonus: goodsView(bonus) }), progress },
    });
  },

  run_for_mayor(run, a, p) {
    const E = BALANCE.election;
    const e = run.s.village.election;
    if (a.level < E.runLevel) fail('LEVEL_REQUIRED', 'mayor_level', { level: E.runLevel });
    if (e.candidates.some((c) => c.id === a.id)) fail('CONFLICT', 'already_candidate', { election: e.n });
    const text = cleanText(p.platform, MAX_PLATFORM_LEN, true);
    e.candidates.push({ id: a.id, name: a.name, at: run.now, platform: text, lang: a.lang });
    run.s.dirty.add('village');
    bump(run, a, 'candidacies');
    tell(run, e.phase === 'voting' ? 'n.run_for_mayor_voting' : 'n.run_for_mayor', { n: e.candidates.length, hours: Math.max(1, Math.ceil((e.voteAt - run.now) / 3_600_000)) });
    // The platform is agent text: it travels only in payload.text.
    emit(run, 'run_for_mayor', { room: a.room, actor: a.id, vis: 'public', to: 'room', lang: a.lang, drama: 4, data: { text, election: e.n } });
  },

  vote(run, a, p) {
    const E = BALANCE.election;
    const e = run.s.village.election;
    if (e.phase !== 'voting') fail('NOT_ALLOWED', 'vote_not_open', { hours: Math.max(1, Math.ceil((e.voteAt - run.now) / 3_600_000)) });
    if (a.level < E.voteLevel) fail('LEVEL_REQUIRED', 'vote_level', { level: E.voteLevel });
    const already = own(e.votes, a.id);
    if (already) fail('CONFLICT', 'already_voted', { name: e.candidates.find((c) => c.id === already)?.name ?? '' });
    const id = run.s.byName.get(normalizeName(p.candidate));
    const cand = id ? e.candidates.find((c) => c.id === id) : undefined;
    if (!cand) fail('TARGET_NOT_FOUND', 'not_candidate', { name: p.candidate });
    if (run.s.agents.get(cand.id)?.status !== 'active') fail('NOT_ALLOWED', 'candidate_gone', { name: cand.name });
    if (cand.id === a.id) fail('NOT_ALLOWED', 'vote_self');
    e.votes[a.id] = cand.id;
    e.tally[cand.id] = (own(e.tally, cand.id) ?? 0) + 1;
    run.s.dirty.add('village');
    bump(run, a, 'votes');
    questEvent(run, a, 'vote');
    tell(run, 'n.vote', { name: cand.name });
    // The ballot is secret: the event says that the agent voted, not for whom. Totals are sealed until the election
    // closes (village view: only the turnout).
    emit(run, 'vote', { room: a.room, actor: a.id, to: 'room', drama: 1, m: msg('ev.vote', { actor: a.name }), data: { election: e.n } });
  },

  mayor_priority(run, a, p) {
    mayorOnly(run, a);
    const proj = availableProject(run, p.project);
    const v = run.s.village;
    if (v.priority === proj.id) fail('CONFLICT', 'priority_same', { proj: ref.proj(proj.id) });
    v.priority = proj.id;
    run.s.dirty.add('village');
    tell(run, 'n.mayor_priority', { proj: ref.proj(proj.id), pct: BALANCE.village.priorityBonusPct });
    emit(run, 'mayor_priority', {
      room: a.room,
      actor: a.id,
      vis: 'public',
      drama: 3,
      m: msg('ev.mayor_priority', { actor: a.name, proj: ref.proj(proj.id), pct: BALANCE.village.priorityBonusPct }),
      data: { project: proj.id },
    });
  },

  mayor_tax(run, a, p) {
    mayorOnly(run, a);
    const max = BALANCE.village.taxMax;
    if (!(p.rate >= 0 && p.rate <= max)) fail('INVALID_PARAMS', 'tax_range', { max: pct(max) });
    const rate = Math.round(p.rate * 10_000) / 10_000;
    const v = run.s.village;
    if (rate === v.taxRate) fail('CONFLICT', 'tax_same', { pct: pct(rate) });
    const old = v.taxRate;
    v.taxRate = rate;
    run.s.dirty.add('village');
    tell(run, 'n.mayor_tax', { pct: pct(rate) });
    emit(run, 'mayor_tax', {
      room: a.room,
      actor: a.id,
      vis: 'public',
      drama: rate > old ? 4 : 3,
      m: msg('ev.mayor_tax', { actor: a.name, pct: pct(rate), old: pct(old) }),
      data: { rate, old },
    });
  },

  mayor_fund(run, a, p) {
    mayorOnly(run, a);
    const proj = availableProject(run, p.project);
    const v = run.s.village;
    const asked = wholeNumber(p.gold, 'gold', 1);
    if (!covers(v.treasury, asked)) fail('NOT_ENOUGH_GOLD', 'treasury_lacks', { need: asked, have: v.treasury });
    const gold = Math.min(asked, missingFor(run.s, proj).gold);
    if (!(gold > 0)) fail('CONFLICT', 'project_no_gold_needed', { proj: ref.proj(proj.id) });
    debitTreasury(v, gold, 'village treasury');
    deliver(run, proj, null, { gold, items: [] }, { gold: 0, items: [] });
    const progress = progressOf(run.s, proj);
    tell(run, 'n.mayor_fund', { proj: ref.proj(proj.id), gold, left: v.treasury, pct: Math.round(progress * 100) });
    if (projectStatus(run.s, proj) === 'done') tell(run, 'n.project_done', { proj: ref.proj(proj.id) });
    emit(run, 'mayor_fund', {
      room: a.room,
      actor: a.id,
      vis: 'public',
      drama: 4,
      m: msg('ev.mayor_fund', { actor: a.name, proj: ref.proj(proj.id), gold }),
      data: { project: proj.id, gold, treasury: v.treasury, progress },
    });
  },

  mayor_embezzle(run, a, p) {
    mayorOnly(run, a);
    const v = run.s.village;
    const n = v.election.n;
    const taken = v.embezzled.election === n ? v.embezzled.gold : 0;
    // Up to a share of what the treasury would hold had nothing been taken this week: splitting it up gains nothing.
    const cap = Math.max(0, Math.floor((v.treasury + taken) * BALANCE.village.embezzleShare) - taken);
    const gold = wholeNumber(p.gold, 'gold', 1);
    if (!(gold <= cap)) fail('NOT_ALLOWED', 'embezzle_cap', { max: cap, pct: pct(BALANCE.village.embezzleShare) });
    debitTreasury(v, gold, 'village treasury');
    v.embezzled = { election: n, gold: taken + gold };
    addGold(run, a, gold);
    run.s.dirty.add('village');
    bump(run, a, 'embezzled', gold);
    tell(run, 'n.mayor_embezzle', { gold, left: v.treasury });
    emit(run, 'mayor_embezzle', {
      room: a.room,
      actor: a.id,
      vis: 'public',
      drama: 8,
      m: msg('ev.mayor_embezzle', { actor: a.name, gold }),
      data: { gold, treasury: v.treasury, week: taken + gold },
    });
  },

  guild_build_hall(run, a, p) {
    const g = guildOf(run.s, a);
    if (!g) fail('NOT_ALLOWED', 'not_in_guild');
    if (g.leader !== a.id) fail('NOT_ALLOWED', 'guild_not_leader');
    const raw = normId(p.plot);
    const plot = run.c.rooms.has(raw) ? raw : `village.${raw}`;
    const room = run.c.rooms.get(plot);
    if (!room?.flags.includes('plot')) fail('TARGET_NOT_FOUND', 'plot_unknown', { plot: p.plot });
    const site = projectAt(run.c, plot);
    if (site) fail('NOT_ALLOWED', 'plot_reserved', { room: ref.room(plot), proj: ref.proj(site.id) });
    const v = run.s.village;
    const there = own(v.halls, plot);
    if (there) fail('CONFLICT', 'plot_taken', { room: ref.room(plot), guild: run.s.guilds.get(there.guild)?.name ?? '?' });
    const ours = hallOf(run.s, g.id);
    if (ours) fail('CONFLICT', 'guild_has_hall', { room: ref.room(ours) });
    const cost = hallCost();
    const lacks: string[] = [];
    if (!covers(g.treasury, cost.gold)) lacks.push(`gold x${cost.gold - g.treasury}`);
    for (const x of cost.items) if (!covers(own(g.vault, x.item) ?? 0, x.qty)) lacks.push(`${x.item} x${x.qty - (own(g.vault, x.item) ?? 0)}`);
    if (lacks.length) fail('MISSING_ITEMS', 'hall_cost', { guild: g.name, missing: lacks.join(', ') });
    // The cost is a sink: it leaves the economy and becomes a building.
    debitTreasury(g, cost.gold, `treasury of ${g.id}`);
    for (const x of cost.items) stockTake(g.vault, x.item, x.qty, `vault of ${g.id}`);
    v.halls[plot] = { guild: g.id, at: run.now };
    markGuild(run.s, g);
    run.s.dirty.add('village');
    markAgent(run.s, a);
    tell(run, 'n.guild_hall_built', { guild: g.name, room: ref.room(plot) });
    emit(run, 'guild_hall_built', {
      room: plot,
      actor: a.id,
      target: g.id,
      vis: 'public',
      to: g.members,
      drama: 6,
      m: msg('ev.guild_hall_built', { actor: a.name, guild: g.name, room: ref.room(plot) }),
      data: { guild: g.id, name: g.name, colors: g.colors, plot, cost: goodsView(cost) },
    });
  },
};
