/** Runs the pinned scanner against fresh reports and rejects unclassified findings. */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const flags = Bun.argv.slice(2);
const productionOnly = flags.length === 1 && flags[0] === '--production';
if (flags.length > 0 && !productionOnly) throw new Error('Usage: bun run knip [--production]');
const generatedCinderInputs = [
  'components/cinder/src/tokens/registry.generated.ts',
  'components/cinder/src/tokens/runtime/authoring-catalogue.generated.ts',
  'components/cinder/src/tokens/runtime/base-corpus.generated.ts',
  'components/cinder/src/tokens/runtime/package-version.generated.ts',
  'components/cinder/src/tokens/runtime/format-validator.generated.js',
  'components/cinder/src/tokens/runtime/resolver-validator.generated.js',
];
const present = await Promise.all(generatedCinderInputs.map((path) => Bun.file(path).exists()));
if (present.includes(false)) {
  const seeded = Bun.spawnSync(['bun', 'run', '--cwd', 'components/cinder', 'tokens:seed'], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (seeded.exitCode !== 0) process.exit(seeded.exitCode);
}
mkdirSync('test-output/knip', { recursive: true });
const directory = mkdtempSync(join('test-output/knip', 'inventory-'));
const modes = productionOnly ? ['production'] : ['test-inclusive', 'production'];
for (const mode of modes) {
  const reportPath = join(directory, `${mode}.json`);
  const result = Bun.spawnSync(
    [
      'bunx',
      'knip',
      ...(mode === 'production' ? ['--production'] : []),
      '--reporter',
      'json',
      '--output-file',
      `json=${reportPath}`,
    ],
    { stdout: 'inherit', stderr: 'inherit' },
  );
  if (result.exitCode !== 0 && result.exitCode !== 1) process.exit(result.exitCode);
  if (!(await Bun.file(reportPath).exists()))
    throw new Error('Knip did not produce a fresh report.');
  if (productionOnly) {
    process.stdout.write(`${reportPath}\n`);
    process.exit(result.exitCode);
  }
  const baseline =
    mode === 'production'
      ? 'scripts/unused-code-production-baseline.txt'
      : 'scripts/unused-code-baseline.txt';
  const comparison = Bun.spawnSync(['bun', 'scripts/check-unused-code.ts', reportPath, baseline], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (comparison.exitCode !== 0) process.exit(comparison.exitCode);
}
