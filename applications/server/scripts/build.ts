import { rm } from 'node:fs/promises';

const entrypoints = ['./src/index.ts'];

await rm('build', { recursive: true, force: true });

const result = await Bun.build({
  entrypoints,
  outdir: './build',
  target: 'bun',
  format: 'esm',
  naming: '[dir]/[name].js',
  sourcemap: 'external',
  minify: true,
});

if (!result.success) throw new AggregateError(result.logs, 'Server build failed');
