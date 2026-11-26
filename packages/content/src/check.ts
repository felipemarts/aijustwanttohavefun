/* Validates content and English coverage: `pnpm content:check`. Used by CI. */
import { loadContent, loadContentCatalogs } from './node';
import { requiredContentKeys } from './index';

try {
  const c = loadContent();
  const catalogs = loadContentCatalogs();
  const en = catalogs.en ?? {};
  const missing = requiredContentKeys(c).filter((k) => en[k] === undefined);
  console.log(
    `Content OK: ${c.rooms.size} rooms, ${c.monsters.size} monsters, ${c.items.size} items, ${c.recipes.size} recipes, ` +
      `${c.quests.size} quests, ${c.achievements.size} achievements, ${c.projects.size} projects`,
  );
  if (missing.length) {
    console.error(`Missing ${missing.length} English content keys:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
