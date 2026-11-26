/* Coverage report: `pnpm i18n:report`. Exits non-zero if English (reference) has invalid messages
   or if any non-English message fails to parse. Missing non-English keys only warn (fallback to English). */
import { loadLocales } from './node';
import { coverageReport, findInvalidMessages, REFERENCE_LANG } from './index';
import { loadContentCatalogs } from '@ajwf/content/node';

const catalogs = loadContentCatalogs(loadLocales());
let failed = false;
for (const [lang, cat] of Object.entries(catalogs)) {
  const bad = findInvalidMessages(cat, lang);
  if (bad.length) {
    failed = true;
    console.error(`✗ ${lang}: ${bad.length} invalid ICU messages: ${bad.slice(0, 10).join(', ')}`);
  }
}
console.log('Language coverage (reference: en)');
for (const row of coverageReport(catalogs)) {
  const bar = '█'.repeat(Math.round(row.percent / 5)).padEnd(20, '░');
  console.log(`${row.lang.padEnd(6)} ${bar} ${row.percent.toFixed(1)}%  (${row.present}/${row.total})`);
  if (row.lang !== REFERENCE_LANG && process.argv.includes('--missing')) {
    for (const k of row.missing) console.log(`    missing: ${k}`);
  }
}
if (failed) process.exit(1);
