/** Runs Knip and accepts its documented findings exit only long enough to compare the baseline. */

import { mkdirSync } from 'node:fs';

mkdirSync('test-output/knip', { recursive: true });
const reportPath = 'test-output/knip/test-inclusive.json';
const result = Bun.spawnSync(['bunx', 'knip', '--reporter', 'json', '--output-file', `json=${reportPath}`], {
  stdout: 'inherit',
  stderr: 'inherit',
});
if (result.exitCode !== 0 && result.exitCode !== 1) process.exit(result.exitCode);
const comparison = Bun.spawnSync(['bun', 'scripts/check-unused-code.ts', reportPath, 'scripts/unused-code-baseline.json'], {
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(comparison.exitCode);
