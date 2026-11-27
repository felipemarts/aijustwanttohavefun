import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { parse } from 'yaml';
import { buildStaticWorld, flattenContent, flattenStrings } from './src/data/staticWorld.ts';

const target = process.env.AJWF_SERVER ?? 'http://localhost:8710';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTENT_DATA = join(ROOT, 'packages', 'content', 'data');
const CONTENT_I18N = join(ROOT, 'packages', 'content', 'i18n');
const LOCALES = join(ROOT, 'packages', 'i18n', 'locales');
const LANGS = ['en', 'pt-BR', 'es', 'zh-CN', 'ja', 'fr'];
/** `ui.*` sections only the lazy pages use (`virtual:ajwf-ui-en-pages`). */
const PAGE_KEYS = [
  'ui.village.',
  'ui.timeline.',
  'ui.gazette.',
  'ui.secrets.',
  'ui.highlights.',
  'ui.leaderboard.',
  'ui.board.',
  'ui.profile.',
  'ui.guild.',
  'ui.timelapse.',
  'ui.chart.',
];

/**
 * Build-time content, so the web never duplicates world data by hand:
 * - `virtual:ajwf-world`: room geometry, monsters and NPCs per room, project sites (from packages/content/data).
 * - `virtual:ajwf-ui-en`: the English `ui.*` strings, bundled so the shell renders before the catalog fetch.
 * - `virtual:ajwf-catalog/<lang>`: an offline catalog (lazy chunk) used by the mock source and when the server's
 *   `/api/public/i18n/:lang` cannot be reached.
 */
function ajwfContent(): Plugin {
  const PREFIX = 'virtual:ajwf-';
  const readYaml = (file: string): unknown =>
    existsSync(file) ? parse(readFileSync(file, 'utf8')) : undefined;
  const yamlFiles = (dir: string) =>
    existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.yaml')) : [];

  function catalog(lang: string, watch: (f: string) => void): Record<string, string> {
    const out: Record<string, string> = {};
    for (const l of lang === 'en' ? ['en'] : ['en', lang]) {
      for (const f of yamlFiles(join(LOCALES, l))) {
        if (f === 'appearance.yaml') continue;
        watch(join(LOCALES, l, f));
        flattenStrings(readYaml(join(LOCALES, l, f)), '', out);
      }
      for (const f of yamlFiles(join(CONTENT_I18N, l))) {
        watch(join(CONTENT_I18N, l, f));
        flattenContent(f.replace(/\.yaml$/, ''), readYaml(join(CONTENT_I18N, l, f)), out);
      }
    }
    // Only what the spectator renders: interface, narration, directions and content names (plus room descriptions).
    for (const k of Object.keys(out)) {
      const keep =
        k.startsWith('ui.') ||
        k.startsWith('ev.') ||
        k.startsWith('dir.') ||
        k.startsWith('gazette.') ||
        k.startsWith('highlight.') ||
        (k.startsWith('content.') &&
          (k.endsWith('.name') || k.startsWith('content.room.') || k.startsWith('content.emote.')));
      if (!keep) delete out[k];
    }
    return out;
  }

  return {
    name: 'ajwf-content',
    resolveId(id) {
      return id.startsWith(PREFIX) ? `\0${id}` : null;
    },
    load(id) {
      if (!id.startsWith(`\0${PREFIX}`)) return null;
      const name = id.slice(PREFIX.length + 1);
      const watch = (f: string) => this.addWatchFile(f);
      if (name === 'world') {
        const files: Record<string, unknown> = {};
        for (const k of ['rooms', 'monsters', 'npcs', 'projects', 'zones']) {
          watch(join(CONTENT_DATA, `${k}.yaml`));
          files[k] = readYaml(join(CONTENT_DATA, `${k}.yaml`));
        }
        return `export default ${JSON.stringify(buildStaticWorld(files))};`;
      }
      if (name === 'ui-en' || name === 'ui-en-pages') {
        const out: Record<string, string> = {};
        watch(join(LOCALES, 'en', 'ui.yaml'));
        flattenStrings(readYaml(join(LOCALES, 'en', 'ui.yaml')), '', out);
        // The secondary pages' strings ship with their lazy chunks, not with the map's first load.
        const pages = name === 'ui-en-pages';
        for (const k of Object.keys(out)) if (PAGE_KEYS.some((p) => k.startsWith(p)) !== pages) delete out[k];
        return `export default ${JSON.stringify(out)};`;
      }
      const m = /^catalog\/(.+)$/.exec(name);
      if (m && LANGS.includes(m[1]!)) return `export default ${JSON.stringify(catalog(m[1]!, watch))};`;
      return null;
    },
  };
}

export default defineConfig({
  plugins: [react(), ajwfContent()],
  server: {
    port: 5710,
    strictPort: true,
    proxy: {
      '/api': target,
      '/sprites': target,
      '/skill': target,
      '/heartbeat.md': target,
      '/mcp': target,
      '/healthz': target,
      '/og': target,
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true },
    },
  },
  preview: { port: 5710, strictPort: true },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // pixi.js alone is ~580 kB minified (167 kB gzip) and is needed for the first screen
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/pixi.js') || id.includes('node_modules/.pnpm/pixi.js')) return 'pixi';
          if (
            id.includes('react-router') ||
            id.includes('react-dom') ||
            id.includes('/react/') ||
            id.includes('scheduler')
          )
            return 'react';
          return undefined;
        },
      },
    },
  },
});
