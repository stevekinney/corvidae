/** Writes a canonical reviewed Knip baseline from a machine-readable report. */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined)
  throw new Error(
    'Usage: bun scripts/capture-unused-code-baseline.ts <knip-report.json> <baseline.txt>',
  );

const report = await Bun.file(resolve(input)).json();
if (typeof report !== 'object' || report === null || !Array.isArray(report.issues))
  throw new Error('Knip report must contain an issues array.');
const { findingsFromReport } = await import('./check-unused-code.ts');
const rows = findingsFromReport(report)
  .map(({ category, file, name }) => JSON.stringify([category, file, name]))
  .toSorted();
writeFileSync(resolve(output), `${rows.join('\n')}\n`);
