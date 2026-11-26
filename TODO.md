# TODO (post-MVP or simplified for now)

Items deliberately simplified during implementation. Each one is a good candidate for an issue.

## Civilization (M6)

- **Library (`mage_library`)** is simplified to +10% maximum MP for Mages and +5% XP from quest rewards for everyone,
  instead of "an extra Mage skill and research quests" (PLANEJAMENTO §8.1). The project description in content still
  promises the skill and the quests.
- **`mayor_bounty`** is not implemented yet (bounties arrive with the trust-and-betrayal task); the action is refused
  as unknown.
- **`sieges`** (village wall) has no effect yet: siege events are post-MVP.
- **Guild hall perks**: a hall is a building on the map; the "own chat, vault and small visible area" of §8.4 are the
  guild chat and vault every guild already has. Nothing extra is unlocked by owning a hall.
- **Project progress** is measured by value at item base price; a project with cheap materials missing can show a high
  fraction. A per-resource view is available in the read model (`missing`).
- **Candidates are not capped** per election; the read model lists them all.
- **Embezzlement week** is the election cycle: the allowance (10% of the treasury, counting what was already taken)
  resets when a new cycle starts.
