import { own, PROFESSIONS, ref } from '@ajwf/shared';
import { addItem, bump, canFit, count, gainXp, hasAll, removeItem } from '../agent';
import { BALANCE } from '../balance';
import { questEvent } from '../quests';
import { emit, fail, markRoom, msg, tell } from '../run';
import { peekResource, refreshResource } from '../world';
import { normId, oneOf, roomDef, type HandlerMap } from './util';

export const PROFESSION_LEVEL = 5;

export const workActions: HandlerMap = {
  gather(run, a, p) {
    const id = normId(p.resource);
    const node = peekResource(run.s, a.room, id, run.now);
    if (!node) {
      const here = roomDef(run, a).resources.map((r) => r.id);
      fail('NOT_AVAILABLE_HERE', here.length ? 'resource_not_here' : 'nothing_to_gather', { resource: p.resource, here: here.join(', ') });
    }
    if (!(node.qty > 0)) fail('NOT_AVAILABLE_HERE', 'resource_depleted', { item: ref.item(id) });
    if (!canFit(run.c, a, [{ item: id, qty: 1 }])) fail('INVENTORY_FULL', 'inventory_full');
    refreshResource(run.s, a.room, id, run.now);
    own(run.s.rooms.get(a.room)!.resources, id)!.qty -= 1;
    markRoom(run.s, a.room);
    addItem(a, id, 1);
    bump(run, a, 'gathers');
    const xp = gainXp(run, a, BALANCE.xp.gatherBase + roomDef(run, a).level);
    tell(run, 'n.gather', { item: ref.item(id), left: node.qty - 1, xp });
    emit(run, 'gather', { room: a.room, actor: a.id, m: msg('ev.gather', { actor: a.name, item: ref.item(id) }), data: { item: id } });
    questEvent(run, a, 'gather', id);
  },

  choose_profession(run, a, p) {
    const prof = oneOf(p.profession, PROFESSIONS, 'choose_profession', 'profession');
    if (a.profession) fail('CONFLICT', 'profession_taken', { prof: ref.prof(a.profession) });
    if (a.level < PROFESSION_LEVEL) fail('LEVEL_REQUIRED', 'profession_level', { level: PROFESSION_LEVEL });
    a.profession = prof;
    tell(run, 'n.profession_chosen', { prof: ref.prof(prof) });
    emit(run, 'profession', { room: a.room, actor: a.id, vis: 'public', to: 'room', drama: 1, m: msg('ev.profession', { actor: a.name, prof: ref.prof(prof) }), data: { profession: prof } });
    questEvent(run, a, 'profession', prof);
  },

  craft(run, a, p) {
    const recipe = run.c.recipes.get(normId(p.recipe));
    if (!recipe) fail('TARGET_NOT_FOUND', 'recipe_unknown', { recipe: p.recipe });
    if (a.profession !== recipe.profession) fail('PROFESSION_REQUIRED', 'recipe_profession', { prof: ref.prof(recipe.profession), recipe: ref.recipe(recipe.id) });
    if (a.level < recipe.level) fail('LEVEL_REQUIRED', 'recipe_level', { recipe: ref.recipe(recipe.id), level: recipe.level });
    if (!roomDef(run, a).stations.includes(recipe.station)) fail('NOT_AVAILABLE_HERE', 'no_station', { prof: ref.prof(recipe.profession) });
    if (!hasAll(a, recipe.inputs)) {
      const missing = recipe.inputs.filter((s) => !(count(a, s.item) >= s.qty)).map((s) => `${s.item} x${s.qty - count(a, s.item)}`);
      fail('MISSING_ITEMS', 'recipe_inputs', { recipe: ref.recipe(recipe.id), missing: missing.join(', ') });
    }
    if (!canFit(run.c, a, [recipe.output], recipe.inputs)) fail('INVENTORY_FULL', 'inventory_full');
    for (const s of recipe.inputs) removeItem(a, s.item, s.qty);
    addItem(a, recipe.output.item, recipe.output.qty);
    bump(run, a, 'crafts');
    const xp = gainXp(run, a, BALANCE.xp.craftBase + recipe.level * BALANCE.xp.craftPerLevel);
    tell(run, 'n.craft', { item: ref.item(recipe.output.item), qty: recipe.output.qty, xp });
    emit(run, 'craft', { room: a.room, actor: a.id, m: msg('ev.craft', { actor: a.name, item: ref.item(recipe.output.item) }), data: { recipe: recipe.id, item: recipe.output.item } });
    questEvent(run, a, 'craft', recipe.id);
  },
};
