/** Map palette: a restrained set per zone, one shared outline colour. */
export const OUTLINE = 0x241a2e;
export const VOID = 0x1b1726;

export const P = {
  // Village
  grass: 0x7fb069,
  grassDark: 0x6a9a58,
  grassLight: 0x9bc77e,
  cobble: 0xb9a58c,
  cobbleDark: 0x958169,
  cobbleLight: 0xd2c2a6,
  dirt: 0xa98b63,
  dirtDark: 0x8a6d4a,
  plaster: 0xefe3c8,
  plasterShade: 0xd6c6a6,
  timber: 0x6b4a33,
  roof: 0xc8553d,
  roofDark: 0x9e3f2f,
  roofLight: 0xe07a5c,
  door: 0x5a3a24,
  window: 0x3b4660,
  windowLit: 0xf8d27a,
  stone: 0x9a96a2,
  stoneDark: 0x77737f,
  stoneLight: 0xbdb9c4,
  wood: 0x8a6440,
  woodDark: 0x67472c,
  woodLight: 0xb08458,
  flowerRed: 0xe0605a,
  flowerYellow: 0xf2d06b,
  flowerWhite: 0xf1e6cf,
  flowerBlue: 0x7fa6e8,
  fountainWater: 0x6fb2d6,
  gold: 0xf2b84b,
  amber: 0xf2b84b,
  // Forest
  forest: 0x3f7d5a,
  forestDark: 0x2f5d50,
  forestLight: 0x4f9468,
  canopy: 0x2f6b4a,
  canopyMid: 0x3f8a5a,
  canopyLight: 0x62a86e,
  trunk: 0x5a3f2c,
  mushroom: 0xc8553d,
  // Hills
  dry: 0xc2a860,
  dryDark: 0xa88f4c,
  dryLight: 0xd8c27c,
  boulder: 0x8c8a94,
  boulderDark: 0x6a6874,
  boulderLight: 0xb0aeb8,
  // Mines
  cave: 0x4a4458,
  caveDark: 0x3c3748,
  caveLight: 0x5a5468,
  rock: 0x2e2a3a,
  rockMid: 0x3b3549,
  rockLight: 0x585070,
  copper: 0xd9823b,
  iron: 0xa9a9b3,
  silver: 0xe6e8f0,
  crystal: 0x6fe3e8,
  // Swamp
  murk: 0x3b6b6b,
  murkDark: 0x2c5555,
  murkLight: 0x548a84,
  mud: 0x52593c,
  mudDark: 0x434a30,
  moss: 0x66753f,
  reed: 0x8a9a46,
  deadwood: 0x6b5e52,
  plank: 0x8a6a46,
  plankDark: 0x664c30,
  mist: 0xc9d9d2,
  // Ruins
  flag: 0xb0a089,
  flagDark: 0x948570,
  flagLight: 0xc8b99f,
  sand: 0xc9b48a,
  sandDark: 0xb09a70,
  column: 0xd8cbb0,
  ivy: 0x4f8a4a,
  // Dungeon
  brick: 0x3a3145,
  brickDark: 0x2a2333,
  brickLight: 0x4a3f58,
  dwall: 0x1f1828,
  dwallLight: 0x2c2338,
  bone: 0xe6dcc6,
  // Water
  water: 0x4a86a8,
  waterDark: 0x3a6e8e,
  waterLight: 0x7fb4cc,
  foam: 0xd8ecf0,
  bank: 0x8a7a5a,
} as const;

export const CLASS_COLORS: Record<string, number> = {
  warrior: 0xd9534f,
  mage: 0x5b8def,
  rogue: 0x5fbf6b,
  cleric: 0xe8c35a,
};

export function classColor(c: string): number {
  return CLASS_COLORS[c] ?? 0xf1e6cf;
}
