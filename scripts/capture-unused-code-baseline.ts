/** Writes a canonical reviewed Knip baseline from a machine-readable report. */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined)
  throw new Error('Usage: bun scripts/capture-unused-code-baseline.ts <knip-report.json> <baseline.json>');

const report = await Bun.file(resolve(input)).json();
if (typeof report !== 'object' || report === null || !Array.isArray(report.issues))
  throw new Error('Knip report must contain an issues array.');
const issues = report.issues.toSorted((left, right) => {
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null)
    throw new Error('Knip report issues must be objects.');
  return String((left as { file?: unknown }).file).localeCompare(
    String((right as { file?: unknown }).file),
  );
});
writeFileSync(resolve(output), `${JSON.stringify({ issues }, null, 2)}\n`);
