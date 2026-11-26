import { capacity, derive, levelCap, slotsUsed } from './agent';
import { BALANCE, xpToNext } from './balance';
import type { WorldState } from './types';
import { spawnSlots } from './world';

const isNatural = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/**
 * Checks the rules that must hold after any sequence of actions and ticks (PLANEJAMENTO §16.4).
 * Returns human-readable violations (developer text, not game text); an empty list means the world is sound.
 * Cost is linear in the size of the world: meant for tests and simulations, not for the live loop.
 */
export function checkInvariants(s: WorldState, now: number): string[] {
  const out: string[] = [];
  const c = s.content;

  for (const a of s.agents.values()) {
    const who = `agent ${a.id} (${a.name})`;
    if (!isNatural(a.gold)) out.push(`${who}: gold ${a.gold} is not a non-negative integer`);
    if (!Number.isInteger(a.ap) || a.ap < 0 || a.ap > BALANCE.ap.max) out.push(`${who}: AP ${a.ap} outside [0, ${BALANCE.ap.max}]`);
    if (!Number.isInteger(a.level) || a.level < 1 || a.level > BALANCE.maxLevel) out.push(`${who}: level ${a.level} outside [1, ${BALANCE.maxLevel}]`);
    if (!a.claimed && a.level > BALANCE.unclaimedMaxLevel) out.push(`${who}: unclaimed agent at level ${a.level}`);
    const cap = levelCap(a);
    if (!(a.xp >= 0) || (a.level < cap && a.xp >= xpToNext(a.level))) out.push(`${who}: xp ${a.xp} out of range for level ${a.level}`);
    if (!c.classes.has(a.cls)) out.push(`${who}: unknown class ${a.cls}`);

    if (c.classes.has(a.cls)) {
      const d = derive(c, a, now);
      if (!(a.hp <= d.maxHp + 1e-9)) out.push(`${who}: HP ${a.hp} above max ${d.maxHp}`);
      if (!(a.mp >= 0) || !(a.mp <= d.maxMp + 1e-9)) out.push(`${who}: MP ${a.mp} outside [0, ${d.maxMp}]`);
    }
    if (a.hp <= 0 && !a.fallen) out.push(`${who}: HP ${a.hp} while standing`);
    if (a.fallen && a.hp !== 0) out.push(`${who}: fallen with HP ${a.hp}`);
    if (Number.isNaN(a.hp)) out.push(`${who}: HP is NaN`);

    for (const [id, qty] of Object.entries(a.inv)) {
      if (!Number.isInteger(qty) || qty <= 0) out.push(`${who}: ${qty} x ${id} in inventory`);
      if (!c.items.has(id)) out.push(`${who}: unknown item ${id} in inventory`);
    }
    for (const [slot, id] of Object.entries(a.equip)) {
      if (id === null) continue;
      const item = c.items.get(id);
      if (!item) out.push(`${who}: unknown item ${id} equipped`);
      else if (item.type !== slot) out.push(`${who}: ${id} (${item.type}) equipped as ${slot}`);
    }
    const used = slotsUsed(c, a.inv);
    if (used > capacity(c, a)) out.push(`${who}: ${used} inventory slots used of ${capacity(c, a)}`);

    for (const [qid, prog] of Object.entries(a.quests)) {
      const q = c.quests.get(qid);
      if (!q) {
        out.push(`${who}: unknown active quest ${qid}`);
        continue;
      }
      prog.steps.forEach((n, i) => {
        const need = q.steps[i]?.qty ?? 0;
        if (!isNatural(n) || n > need) out.push(`${who}: quest ${qid} step ${i} progress ${n} of ${need}`);
      });
    }
    if (Object.keys(a.quests).length > BALANCE.inventory.maxActiveQuests) out.push(`${who}: too many active quests`);

    if (!c.rooms.has(a.room)) out.push(`${who}: in unknown room ${a.room}`);
    const here = s.roomAgents.get(a.room);
    if (a.status === 'active' && !here?.has(a.id)) out.push(`${who}: missing from the index of room ${a.room}`);
    if (s.byName.get(a.norm) !== a.id) out.push(`${who}: name index points to ${s.byName.get(a.norm)}`);
    if (s.bySkeleton.get(a.skeleton) !== a.id) out.push(`${who}: skeleton index points to ${s.bySkeleton.get(a.skeleton)}`);
  }

  for (const [roomId, ids] of s.roomAgents) {
    for (const id of ids) {
      const a = s.agents.get(id);
      if (!a) out.push(`room ${roomId}: indexes unknown agent ${id}`);
      else if (a.room !== roomId) out.push(`room ${roomId}: indexes ${id}, who is in ${a.room}`);
      else if (a.status !== 'active') out.push(`room ${roomId}: indexes inactive agent ${id}`);
    }
  }
  for (const [norm, id] of s.byName) if (s.agents.get(id)?.norm !== norm) out.push(`name index: ${norm} -> ${id} does not match`);
  for (const [sk, id] of s.bySkeleton) if (s.agents.get(id)?.skeleton !== sk) out.push(`skeleton index: ${sk} -> ${id} does not match`);

  const uids = new Set<string>();
  for (const [roomId, st] of s.rooms) {
    const def = c.rooms.get(roomId);
    if (!def) {
      out.push(`room state for unknown room ${roomId}`);
      continue;
    }
    const slots = spawnSlots(c, roomId);
    const taken = new Set<number>();
    for (const m of st.monsters) {
      const kind = c.monsters.get(m.kind);
      const what = `room ${roomId}: monster ${m.uid} (${m.kind})`;
      if (!kind) out.push(`${what}: unknown kind`);
      if (!(m.hp > 0)) out.push(`${what}: HP ${m.hp}`);
      if (kind && m.hp > kind.hp) out.push(`${what}: HP ${m.hp} above max ${kind.hp}`);
      if (uids.has(m.uid)) out.push(`${what}: duplicate uid`);
      uids.add(m.uid);
      if (m.slot >= 0) {
        if (slots[m.slot]?.kind !== m.kind) out.push(`${what}: does not belong to slot ${m.slot}`);
        if (taken.has(m.slot)) out.push(`${what}: second living monster in slot ${m.slot}`);
        taken.add(m.slot);
      }
    }
    for (const r of def.resources) {
      const node = st.resources[r.id];
      if (!node) out.push(`room ${roomId}: resource ${r.id} has no state`);
      else if (!isNatural(node.qty) || node.qty > r.max) out.push(`room ${roomId}: resource ${r.id} stock ${node.qty} outside [0, ${r.max}]`);
    }
    for (const [id, qty] of Object.entries(st.ground)) {
      if (!Number.isInteger(qty) || qty <= 0) out.push(`room ${roomId}: ${qty} x ${id} on the ground`);
      if (!c.items.has(id)) out.push(`room ${roomId}: unknown item ${id} on the ground`);
    }
  }
  return out;
}
