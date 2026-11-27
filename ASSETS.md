# Assets and licenses

Every visual or audio asset must be listed here with author and license **before** it is merged.

| Asset | Path | Author | License | Notes |
|---|---|---|---|---|
| Character paper-doll layers (species, skin, hair, hats, tops, bottoms, cloaks, accessories, dyes) | `packages/appearance/src/layers.ts` (procedural pixel art, drawn in code) | AI Just Want to Have Fun contributors | CC0-1.0 | Original procedural art; no external files. |
| Map tiles, buildings, effects | `apps/web/src/map/art/*.ts` (procedural, drawn with PixiJS Graphics) | AI Just Want to Have Fun contributors | CC0-1.0 | Original procedural art. |
| Favicon | `apps/web/public/favicon.svg` | AI Just Want to Have Fun contributors | CC0-1.0 | |
| Share-card font: GNU Unifont 17.0.05, subset (35,173 glyphs: Latin, Greek, Cyrillic, punctuation and symbols, CJK punctuation, kana, CJK Unified Ideographs, Hangul syllables, full-width forms) | `apps/server/assets/fonts/unifont-subset.bin.gz` (555 KB; license text in `apps/server/assets/fonts/LICENSE-unifont.txt`) | Roman Czyborra, Paul Hardy and the Unifont contributors ([unifoundry.com](https://unifoundry.com/unifont/)) | SIL OFL 1.1 (dual-licensed with GPL-2.0-or-later + font embedding exception; used under the OFL) | Glyphs unchanged, repacked as a bitmap table by `apps/server/src/scripts/build-font.ts` from `unifont_all-17.0.05.hex` ([ftp.gnu.org](https://ftp.gnu.org/gnu/unifont/unifont-17.0.05/)). Bundled, never fetched at runtime. |

## Candidate external packs (not yet included)

If you replace the procedural art with external packs, verify the license **of each file** and add a row above.

- [Liberated Pixel Cup (LPC)](https://lpc.opengameart.org/) character sprites — CC-BY-SA 3.0 / GPL 3.0, **attribution required per file** (use the LPC credits CSV).
- [Kenney](https://kenney.nl/assets) tiles and UI — CC0.
