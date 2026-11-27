import type { Puzzle } from '@ajwf/content';
import { own, ref, type ActionName } from '@ajwf/shared';
import { addBuff, bump, count, derive, giveOrDrop, removeItem, touch } from '../agent';
import { BALANCE, rogueChance } from '../balance';
import { raiseBond } from '../bond';
import { hurt } from '../combat';
import { gateBlocker } from '../gates';
import {
  creditSolve,
  gateHolder,
  needClass,
  openPuzzle,
  PUZZLE_ACTION,
  PUZZLE_CLASS,
  puzzleLootReceiver,
  puzzleRef,
  puzzleState,
  WINCH,
  winchesIn,
} from '../puzzles';
import { emit, fail, markAgent, msg, tell, type Run } from '../run';
import type { AgentState, PuzzleState } from '../types';
import { refreshMonster } from '../world';
import { exitOf } from './move';
import { agentHere, normId, type HandlerMap } from './util';

type Found = { pz: Puzzle; st: PuzzleState; target: string; winch: boolean };

/**
 * The puzzle an action points at in the agent's room: by one of its targets ("sun_lever", "old_chest"), by its id,
 * or the winch of a gate whose far side this is. Checks the action and the class before anything changes.
 */
function findPuzzle(run: Run, a: AgentState, action: ActionName, raw: string): Found {
  const id = normId(raw).replace(/^@?puzzle[:.]/, '');
  const here = run.c.puzzlesByRoom.get(a.room) ?? [];
  const winches = winchesIn(run.c, a.room);
  if (action === 'pull_lever') {
    const w = winches.find((pz) => id === WINCH || id === pz.id);
    if (w) return { pz: w, st: puzzleState(run.s, w.id), target: WINCH, winch: true };
  }
  const pz = here.find((x) => x.targets.includes(id) || x.id === id);
  if (!pz) {
    const names = [...here.flatMap((x) => x.targets), ...(winches.length ? [WINCH] : [])];
    fail('TARGET_NOT_FOUND', names.length ? 'puzzle_unknown' : 'no_puzzle_here', { target: raw, here: names.join(', ') });
  }
  const need = PUZZLE_ACTION[pz.type];
  if (need !== action) fail('NOT_ALLOWED', 'puzzle_wrong_action', { puzzle: puzzleRef(pz.id), action, need });
  const cls = PUZZLE_CLASS[pz.type];
  if (cls) needClass(a, cls, action);
  const st = puzzleState(run.s, pz.id);
  let target = pz.targets.includes(id) ? id : pz.targets[0]!;
  if (pz.type === 'levers' && !pz.targets.includes(id)) {
    // Named by the puzzle id: the first lever not pulled in the current window.
    const live = (t: string) => (own(st.pulls, t)?.at ?? -Infinity) > run.now - pz.window_sec * 1000;
    target = pz.targets.find((t) => !live(t)) ?? target;
  }
  return { pz, st, target, winch: false };
}

function secondsLeft(run: Run, until: number): number {
  return Math.max(1, Math.ceil((until - run.now) / 1000));
}

/** The way is already open: nothing to do. */
function refuseOpen(run: Run, pz: Puzzle, st: PuzzleState): void {
  if (st.open > run.now) fail('CONFLICT', 'puzzle_open', { puzzle: puzzleRef(pz.id), seconds: secondsLeft(run, st.open) });
}

/** Opens the way, credits the solvers and tells the room. */
function solve(run: Run, a: AgentState, pz: Puzzle, st: PuzzleState, solvers: AgentState[]): void {
  openPuzzle(run, pz, st, pz.open_sec * 1000);
  creditSolve(run, pz, solvers);
  tell(run, 'n.puzzle_solved', { puzzle: puzzleRef(pz.id), seconds: pz.open_sec });
  emit(run, 'puzzle_solved', {
    room: pz.room,
    actor: a.id,
    to: 'room',
    drama: 2,
    m: msg('ev.puzzle_solved', { actor: a.name, puzzle: puzzleRef(pz.id), seconds: pz.open_sec }),
    data: { puzzle: pz.id, by: solvers.map((b) => b.name) },
  });
}

/** Turns the winch on the far side of a gate: it rises for a short while, whoever holds it or not. */
function winch(run: Run, a: AgentState, pz: Puzzle, st: PuzzleState): void {
  const ms = BALANCE.puzzle.winchMs;
  st.winch = run.now + ms;
  run.s.timers.push({ at: st.winch, kind: 'puzzle', id: pz.id });
  const p = { puzzle: puzzleRef(pz.id), seconds: ms / 1000 };
  tell(run, 'n.winch', p);
  emit(run, 'winch', { room: pz.room, actor: a.id, to: 'room', m: msg('ev.winch', p), data: { puzzle: pz.id } });
  emit(run, 'winch', { room: a.room, actor: a.id, to: 'room', m: msg('ev.winch_here', { actor: a.name, ...p }), data: { puzzle: pz.id } });
}

function pullLever(run: Run, a: AgentState, pz: Puzzle, st: PuzzleState, target: string): void {
  refuseOpen(run, pz, st);
  const windowMs = pz.window_sec * 1000;
  const live: PuzzleState['pulls'] = {};
  for (const [t, pull] of Object.entries(st.pulls)) if (pull.at > run.now - windowMs && pz.targets.includes(t)) live[t] = pull;
  const mine = Object.entries(live).find(([t, pull]) => t !== target && pull.by === a.id)?.[0];
  if (mine) fail('NOT_ALLOWED', 'lever_same_agent', { target, other: mine, seconds: pz.window_sec });
  live[target] = { by: a.id, at: run.now };
  st.pulls = live;
  const left = pz.targets.filter((t) => own(live, t) === undefined);
  if (left.length) {
    tell(run, 'n.lever_pulled', { target, left: left.length, seconds: pz.window_sec });
    emit(run, 'lever_pulled', { room: a.room, actor: a.id, to: 'room', m: msg('ev.lever_pulled', { actor: a.name, target, seconds: pz.window_sec }), data: { puzzle: pz.id, target } });
    return;
  }
  const solvers = [...new Set(Object.values(live).map((x) => x.by))]
    .map((id) => run.s.agents.get(id))
    .filter((b): b is AgentState => !!b && b.status === 'active');
  st.pulls = {};
  for (const b of solvers) if (b !== a) touch(run, b);
  solve(run, a, pz, st, solvers);
}

export const utilityActions: HandlerMap = {
  scout(run, a, p) {
    needClass(a, 'rogue', 'scout');
    const room = run.c.rooms.get(a.room)!;
    const { dir, to } = exitOf(room, p.target);
    const gate = own(room.gates, dir);
    const block = gate ? gateBlocker(run, a, gate) : null;
    const monsters: { id: string; n: number; lvl: number }[] = [];
    for (const m of run.s.rooms.get(to)?.monsters ?? []) {
      refreshMonster(run.s, m, run.now);
      const row = monsters.find((x) => x.id === m.kind);
      if (row) row.n++;
      else monsters.push({ id: m.kind, n: 1, lvl: run.c.monsters.get(m.kind)!.level });
    }
    const agents = run.s.roomAgents.get(to)?.size ?? 0;
    run.data.scout = { dir, room: to, monsters, agents, ...(block && gate ? { locked: gate.requires } : {}) };
    tell(run, 'n.scout', { dir: ref.dir(dir), room: ref.room(to), monsters: monsters.reduce((n, m) => n + m.n, 0), agents });
    if (block) tell(run, 'n.scout_locked');
    bump(run, a, 'scouts');
  },

  enchant(run, a, p) {
    needClass(a, 'mage', 'enchant');
    const E = BALANCE.enchant;
    const b = p.target ? agentHere(run, a, p.target) : a;
    if (b.fallen) fail('NOT_ALLOWED', 'target_fallen', { name: b.name });
    if (!b.equip.weapon) fail('NOT_ALLOWED', 'enchant_no_weapon', { name: b.name });
    if (!(count(a, E.item) >= 1)) fail('MISSING_ITEMS', 'enchant_material', { item: ref.item(E.item) });
    removeItem(a, E.item, 1);
    if (b !== a) touch(run, b);
    addBuff(b, { id: 'enchant', stat: 'atk', value: E.atk, until: run.now + E.durationMs });
    markAgent(run.s, b);
    bump(run, a, 'enchants');
    const minutes = Math.round(E.durationMs / 60_000);
    const weapon = ref.item(b.equip.weapon);
    if (b === a) tell(run, 'n.enchant_self', { item: weapon, atk: E.atk, minutes });
    else {
      tell(run, 'n.enchant', { name: b.name, item: weapon, atk: E.atk, minutes });
      raiseBond(run, a, b, BALANCE.bond.enchant);
    }
    emit(run, 'enchant', {
      room: a.room,
      actor: a.id,
      target: b.id,
      to: 'room',
      drama: 1,
      m: msg('ev.enchant', { actor: a.name, name: b.name, item: weapon, atk: E.atk, minutes }),
      data: { atk: E.atk },
    });
  },

  pull_lever(run, a, p) {
    const f = findPuzzle(run, a, 'pull_lever', p.target);
    if (f.winch) winch(run, a, f.pz, f.st);
    else pullLever(run, a, f.pz, f.st, f.target);
  },

  hold_gate(run, a, p) {
    const { pz, st } = findPuzzle(run, a, 'hold_gate', p.target);
    const holder = gateHolder(run.s, pz, run.now);
    if (holder && holder !== a) fail('CONFLICT', 'gate_held', { puzzle: puzzleRef(pz.id), name: holder.name });
    if (holder === a) fail('CONFLICT', 'puzzle_open', { puzzle: puzzleRef(pz.id), seconds: secondsLeft(run, st.open) });
    st.hold = { by: a.id, at: run.now };
    st.open = 0;
    openPuzzle(run, pz, st, pz.open_sec * 1000);
    creditSolve(run, pz, [a]);
    tell(run, 'n.gate_held', { puzzle: puzzleRef(pz.id), seconds: pz.open_sec });
    emit(run, 'gate_held', { room: a.room, actor: a.id, to: 'room', drama: 2, m: msg('ev.gate_held', { actor: a.name, puzzle: puzzleRef(pz.id) }), data: { puzzle: pz.id } });
  },

  read_runes(run, a, p) {
    const { pz, st } = findPuzzle(run, a, 'read_runes', p.target);
    refuseOpen(run, pz, st);
    solve(run, a, pz, st, [a]);
  },

  disarm(run, a, p) {
    const { pz, st } = findPuzzle(run, a, 'disarm', p.target);
    refuseOpen(run, pz, st);
    if (run.rng.chance(rogueChance('trap', derive(run.c, a, run.now).agi))) {
      solve(run, a, pz, st, [a]);
      return;
    }
    const dmg = pz.damage;
    tell(run, 'n.trap_failed', { puzzle: puzzleRef(pz.id), dmg });
    emit(run, 'trap_failed', { room: a.room, actor: a.id, to: 'room', drama: 2, m: msg('ev.trap_failed', { actor: a.name, puzzle: puzzleRef(pz.id), dmg }), data: { puzzle: pz.id, dmg } });
    if (dmg > 0) hurt(run, a, dmg, puzzleRef(pz.id));
  },

  pick_lock(run, a, p) {
    const { pz, st } = findPuzzle(run, a, 'pick_lock', p.target);
    const P = BALANCE.puzzle;
    if (st.ready > run.now) fail('NOT_AVAILABLE_HERE', 'lock_empty', { puzzle: puzzleRef(pz.id), minutes: Math.max(1, Math.ceil((st.ready - run.now) / 60_000)) });
    const key = `lock:${pz.id}`;
    const wait = own(a.cooldowns, key) ?? 0;
    if (wait > run.now) fail('COOLDOWN', 'lock_cooldown', { puzzle: puzzleRef(pz.id), seconds: secondsLeft(run, wait) });
    if (!run.rng.chance(rogueChance('lock', derive(run.c, a, run.now).agi))) {
      a.cooldowns[key] = run.now + P.lockFailCooldownMs;
      tell(run, 'n.lock_failed', { puzzle: puzzleRef(pz.id), seconds: P.lockFailCooldownMs / 1000 });
      return;
    }
    delete a.cooldowns[key];
    st.ready = run.now + pz.reset_sec * 1000;
    run.s.timers.push({ at: st.ready, kind: 'puzzle', id: pz.id });
    tell(run, 'n.lock_picked', { puzzle: puzzleRef(pz.id) });
    emit(run, 'lock_picked', { room: a.room, actor: a.id, to: 'room', drama: 2, m: msg('ev.lock_picked', { actor: a.name, puzzle: puzzleRef(pz.id) }), data: { puzzle: pz.id } });
    for (const s of pz.loot) {
      const b = puzzleLootReceiver(run, a);
      if (b !== a) touch(run, b);
      const kept = giveOrDrop(run, b, s.item, s.qty);
      const lp = { item: ref.item(s.item), qty: s.qty };
      if (b === a) tell(run, kept ? 'n.loot' : 'n.loot_ground', lp);
      else {
        tell(run, 'n.loot_to', { name: b.name, ...lp });
        emit(run, 'loot_share', { room: b.room, actor: b.id, vis: 'private', to: [b.id], m: msg(kept ? 'ev.loot_you' : 'ev.loot_you_ground', lp) });
      }
      markAgent(run.s, b);
    }
    creditSolve(run, pz, [a]);
  },
};
