/**
 * Cosmetic catalog. Option ids are stable English identifiers; display names live in
 * `packages/i18n/locales/<lang>/appearance.yaml` under `appearance.<layer>.<id>`.
 * `starter: false` options are only obtainable in game (drops, quests, Tailors).
 */

export const LAYERS = ['species', 'skin', 'hair_style', 'hair_color', 'hat', 'top', 'bottom', 'cloak', 'accessory', 'dye'] as const;
export type Layer = (typeof LAYERS)[number];
export type Appearance = Record<Layer, string>;

export type Rgb = [number, number, number];

export type Option = { id: string; starter: boolean };

export type SpeciesDef = Option & {
  /** Body proportions in a 16x24 frame. */
  body: { headTop: number; torsoTop: number; torsoBottom: number; legBottom: number; wide: boolean };
  ears?: 'pointy' | 'big';
  tusks?: boolean;
  skins: Rgb[];
};

const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

export const SPECIES: SpeciesDef[] = [
  {
    id: 'human',
    starter: true,
    body: { headTop: 4, torsoTop: 11, torsoBottom: 17, legBottom: 22, wide: false },
    skins: ['#f6d5b8', '#eabf98', '#d39b6a', '#a8714a', '#7b4e32', '#4f3121'].map(hex),
  },
  {
    id: 'elf',
    starter: true,
    ears: 'pointy',
    body: { headTop: 3, torsoTop: 10, torsoBottom: 16, legBottom: 22, wide: false },
    skins: ['#fbe6d4', '#f0d0b0', '#d8b48c', '#b98d6a', '#c9d8c0', '#a7b9d6'].map(hex),
  },
  {
    id: 'dwarf',
    starter: true,
    body: { headTop: 7, torsoTop: 13, torsoBottom: 19, legBottom: 22, wide: true },
    skins: ['#f3cfb1', '#e2b28c', '#c98e63', '#a06a45', '#7a4c31', '#e8b9a0'].map(hex),
  },
  {
    id: 'orc',
    starter: true,
    tusks: true,
    body: { headTop: 3, torsoTop: 10, torsoBottom: 17, legBottom: 22, wide: true },
    skins: ['#8fbf6a', '#6f9e4e', '#5a8a5e', '#9aa86a', '#7d8f9e', '#a5845a'].map(hex),
  },
  {
    id: 'gnome',
    starter: true,
    ears: 'big',
    body: { headTop: 9, torsoTop: 15, torsoBottom: 19, legBottom: 22, wide: false },
    skins: ['#f8dcc4', '#efc6a4', '#d8a37c', '#b47c58', '#e9c0b8', '#c8a0d8'].map(hex),
  },
  {
    id: 'goblin',
    starter: true,
    ears: 'pointy',
    body: { headTop: 9, torsoTop: 15, torsoBottom: 19, legBottom: 22, wide: false },
    skins: ['#a6c95a', '#8db04a', '#c2c96a', '#7fae7a', '#b0a050', '#9ac0b0'].map(hex),
  },
];

export const SKIN_IDS = ['s0', 's1', 's2', 's3', 's4', 's5'];

export type HairDef = Option & { shape: 'short' | 'long' | 'mohawk' | 'bald' | 'braids' | 'ponytail' | 'bun' | 'curly' | 'spiky' | 'bob' | 'side' | 'afro' | 'topknot' | 'pigtails' | 'shaggy' };
export const HAIR_STYLES: HairDef[] = (
  ['short', 'long', 'mohawk', 'bald', 'braids', 'ponytail', 'bun', 'curly', 'spiky', 'bob', 'side', 'afro', 'topknot', 'pigtails', 'shaggy'] as const
).map((shape) => ({ id: shape, starter: true, shape }));

export const HAIR_COLORS: (Option & { rgb: Rgb })[] = [
  ['c0', '#1d1a1f'], ['c1', '#4a2f22'], ['c2', '#c0c4cc'], ['c3', '#e8d27a'], ['c4', '#b8622f'], ['c5', '#8a3324'],
  ['c6', '#f2f0ea'], ['c7', '#6a7a34'], ['c8', '#3a64c8'], ['c9', '#c858b0'], ['c10', '#7a4fd0'], ['c11', '#3aa89a'],
].map(([id, h]) => ({ id: id!, starter: true, rgb: hex(h!) }));

export type HatDef = Option & {
  shape: 'none' | 'hood' | 'cone' | 'helm' | 'beret' | 'flowers' | 'cap' | 'bandana' | 'horns' | 'tricorn' | 'crown' | 'straw' | 'tophat' | 'feather' | 'band' | 'witch' | 'turban' | 'cowl' | 'circlet' | 'chef';
  color?: Rgb;
};
export const HATS: HatDef[] = [
  { id: 'none', starter: true, shape: 'none' },
  { id: 'hood', starter: true, shape: 'hood' },
  { id: 'wizard_hat', starter: true, shape: 'cone' },
  { id: 'helm', starter: true, shape: 'helm', color: hex('#9aa3ad') },
  { id: 'beret', starter: true, shape: 'beret' },
  { id: 'flower_crown', starter: true, shape: 'flowers' },
  { id: 'cap', starter: true, shape: 'cap' },
  { id: 'bandana', starter: true, shape: 'bandana' },
  { id: 'horned_helm', starter: true, shape: 'horns', color: hex('#8c939c') },
  { id: 'tricorn', starter: true, shape: 'tricorn' },
  { id: 'crown', starter: false, shape: 'crown', color: hex('#e8b84a') },
  { id: 'straw_hat', starter: true, shape: 'straw', color: hex('#d8b860') },
  { id: 'top_hat', starter: false, shape: 'tophat', color: hex('#26222c') },
  { id: 'feathered_hat', starter: true, shape: 'feather' },
  { id: 'headband', starter: true, shape: 'band' },
  { id: 'witch_hat', starter: true, shape: 'witch', color: hex('#2e2440') },
  { id: 'turban', starter: true, shape: 'turban' },
  { id: 'cowl', starter: true, shape: 'cowl' },
  { id: 'circlet', starter: false, shape: 'circlet', color: hex('#d8dce8') },
  { id: 'chef_hat', starter: true, shape: 'chef', color: hex('#f4f4f0') },
  { id: 'starry_wizard_hat', starter: false, shape: 'cone', color: hex('#2a3a8a') },
];

export type TopDef = Option & {
  sleeves: 'none' | 'short' | 'long';
  pattern: 'plain' | 'stripes' | 'belt' | 'buttons' | 'trim' | 'chain' | 'scales' | 'sash' | 'collar' | 'apron' | 'laces' | 'cross';
  long?: boolean;
  fixed?: Rgb;
};
export const TOPS: TopDef[] = [
  { id: 'tunic', starter: true, sleeves: 'short', pattern: 'belt' },
  { id: 'jerkin', starter: true, sleeves: 'none', pattern: 'laces' },
  { id: 'robe', starter: true, sleeves: 'long', pattern: 'trim', long: true },
  { id: 'shirt', starter: true, sleeves: 'long', pattern: 'buttons' },
  { id: 'vest', starter: true, sleeves: 'none', pattern: 'buttons' },
  { id: 'doublet', starter: true, sleeves: 'long', pattern: 'stripes' },
  { id: 'apron', starter: true, sleeves: 'short', pattern: 'apron' },
  { id: 'chainmail', starter: true, sleeves: 'short', pattern: 'chain', fixed: hex('#a4acb4') },
  { id: 'poncho', starter: true, sleeves: 'none', pattern: 'stripes', long: true },
  { id: 'sweater', starter: true, sleeves: 'long', pattern: 'plain' },
  { id: 'coat', starter: true, sleeves: 'long', pattern: 'collar', long: true },
  { id: 'tabard', starter: true, sleeves: 'short', pattern: 'cross' },
  { id: 'corset', starter: true, sleeves: 'short', pattern: 'laces' },
  { id: 'hoodie', starter: true, sleeves: 'long', pattern: 'collar' },
  { id: 'kimono', starter: true, sleeves: 'long', pattern: 'sash', long: true },
  { id: 'leather_vest', starter: true, sleeves: 'none', pattern: 'belt', fixed: hex('#7a5034') },
  { id: 'sash_shirt', starter: true, sleeves: 'long', pattern: 'sash' },
  { id: 'blouse', starter: true, sleeves: 'long', pattern: 'collar' },
  { id: 'scale_shirt', starter: true, sleeves: 'short', pattern: 'scales', fixed: hex('#7c8a7a') },
  { id: 'patched_jerkin', starter: true, sleeves: 'none', pattern: 'plain' },
  { id: 'royal_doublet', starter: false, sleeves: 'long', pattern: 'trim', fixed: hex('#7a2040') },
  { id: 'silk_robe', starter: false, sleeves: 'long', pattern: 'sash', long: true },
];

export type BottomDef = Option & { shape: 'pants' | 'skirt' | 'shorts' | 'kilt' | 'leggings' | 'long_skirt' | 'breeches' | 'baggy' | 'sarong' | 'robe' };
export const BOTTOMS: BottomDef[] = (
  [
    ['trousers', 'pants'], ['skirt', 'skirt'], ['shorts', 'shorts'], ['kilt', 'kilt'], ['leggings', 'leggings'],
    ['long_skirt', 'long_skirt'], ['breeches', 'breeches'], ['baggy_pants', 'baggy'], ['sarong', 'sarong'], ['robe_skirt', 'robe'],
  ] as const
).map(([id, shape]) => ({ id, starter: true, shape }));

export type CloakDef = Option & { shape: 'none' | 'cape' | 'long' | 'short' | 'tattered' | 'fur' | 'hooded' | 'royal' | 'leaf' | 'feather' | 'shawl'; fixed?: Rgb };
export const CLOAKS: CloakDef[] = [
  { id: 'none', starter: true, shape: 'none' },
  { id: 'cape', starter: true, shape: 'cape' },
  { id: 'long_cloak', starter: true, shape: 'long' },
  { id: 'short_cape', starter: true, shape: 'short' },
  { id: 'tattered_cloak', starter: true, shape: 'tattered' },
  { id: 'fur_mantle', starter: true, shape: 'fur', fixed: hex('#a88a66') },
  { id: 'hooded_cloak', starter: true, shape: 'hooded' },
  { id: 'royal_cape', starter: false, shape: 'royal', fixed: hex('#a02838') },
  { id: 'leaf_cloak', starter: true, shape: 'leaf', fixed: hex('#4f8a3a') },
  { id: 'feather_cloak', starter: false, shape: 'feather', fixed: hex('#3a6ab0') },
  { id: 'shawl', starter: true, shape: 'shawl' },
];

export type AccessoryDef = Option & { kind: string };
export const ACCESSORIES: AccessoryDef[] = [
  'none', 'round_glasses', 'pipe', 'eyepatch', 'earring', 'scar', 'monocle', 'freckles', 'beard', 'mustache',
  'goggles', 'necklace', 'flower', 'nose_ring', 'war_paint', 'bandage',
].map((id) => ({ id, starter: id !== 'monocle', kind: id }));

export const DYES: (Option & { primary: Rgb; secondary: Rgb })[] = [
  ['d0', '#b8323a', '#e8c070'], ['d1', '#3a5ab8', '#e0e0e8'], ['d2', '#3a8a4a', '#c8a060'], ['d3', '#6a3a8a', '#d0b0e0'],
  ['d4', '#c87a2a', '#3a2a1a'], ['d5', '#2a2a32', '#b8323a'], ['d6', '#e8e0d0', '#5a6a8a'], ['d7', '#7a5a3a', '#c8b090'],
  ['d8', '#2a8a8a', '#f0d080'], ['d9', '#c8507a', '#f8e0e8'], ['d10', '#5a6a3a', '#9a8a5a'], ['d11', '#1a3a6a', '#e8b84a'],
  ['d12', '#8a2a2a', '#2a2a2a'], ['d13', '#d8c040', '#6a4a20'], ['d14', '#4a4a5a', '#9ab0c8'], ['d15', '#e87a5a', '#3a6a5a'],
  ['d16', '#f0f0f8', '#e8b84a'],
].map(([id, p, s]) => ({ id: id!, starter: id !== 'd16', primary: hex(p!), secondary: hex(s!) }));

export const CATALOG: Record<Exclude<Layer, 'skin'>, Option[]> = {
  species: SPECIES,
  hair_style: HAIR_STYLES,
  hair_color: HAIR_COLORS,
  hat: HATS,
  top: TOPS,
  bottom: BOTTOMS,
  cloak: CLOAKS,
  accessory: ACCESSORIES,
  dye: DYES,
};

export function optionIds(layer: Layer, starterOnly = false): string[] {
  if (layer === 'skin') return SKIN_IDS;
  return CATALOG[layer].filter((o) => !starterOnly || o.starter).map((o) => o.id);
}

export function hasOption(layer: Layer, id: string): boolean {
  return optionIds(layer).includes(id);
}

const byId = <T extends Option>(list: T[]) => new Map(list.map((o) => [o.id, o]));
export const speciesById = byId(SPECIES);
export const hairById = byId(HAIR_STYLES);
export const hairColorById = byId(HAIR_COLORS);
export const hatById = byId(HATS);
export const topById = byId(TOPS);
export const bottomById = byId(BOTTOMS);
export const cloakById = byId(CLOAKS);
export const accessoryById = byId(ACCESSORIES);
export const dyeById = byId(DYES);
