/**
 * Builds the preview scripts for one shard of components.
 *
 * Usage: bun preview-shard.ts <plans file> <entry directory> <output directory> <report file> <id>…
 *
 * For each id, the shard writes an entry module that mounts the planned examples into the entry
 * directory and bundles it into `<output directory>/<id>/preview.js`. A bundle over the preview
 * script cap is rebuilt with the first example alone; when that is still over the cap, the full
 * bundle is written as `preview.full.js`, for the snapshot stage to turn into a static rendition
 * of every planned example. The shard writes what it built, and with how many examples, to the
 * report file, and exits non-zero when anything failed.
 */

import { sveltePlugin } from '@lostgradient/testing';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { examplesRoot } from './paths.ts';
import {
  escapePreviewScript,
  PREVIEW_SCRIPT_CAP,
  previewEntrySource,
  type PreviewPlan,
  type ShardReport,
} from './previews.ts';

const [plansFile, entryDirectory, outputDirectory, reportFile, ...ids] = Bun.argv.slice(2);
if (!plansFile || !entryDirectory || !outputDirectory || !reportFile || ids.length === 0) {
  console.error(
    'Usage: bun preview-shard.ts <plans file> <entry directory> <output directory> <report file> <id>…',
  );
  process.exit(2);
}
const entries: string = entryDirectory;

const plans = new Map(
  (JSON.parse(readFileSync(plansFile, 'utf8')) as PreviewPlan[]).map((plan) => [plan.id, plan]),
);

/** Bundles one plan, returning the escaped script or the reason it failed. */
async function bundle(plan: PreviewPlan, entryName: string): Promise<string | Error> {
  const entry = join(entries, `${entryName}.ts`);
  writeFileSync(entry, previewEntrySource(plan, examplesRoot));
  const result = await Bun.build({
    entrypoints: [entry],
    format: 'iife',
    target: 'browser',
    minify: true,
    conditions: ['browser', 'svelte'],
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env.DEV': 'false',
      'import.meta.env.SSR': 'false',
    },
    plugins: [sveltePlugin({ generate: 'client', injectCss: true })],
    loader: { '.css': 'css' },
    throw: false,
  });
  if (!result.success) return new Error(result.logs.map(String).join(' | ').slice(0, 400));
  const output = result.outputs.find((artifact) => artifact.path.endsWith('.js'));
  if (!output) return new Error('the bundle produced no script');
  return escapePreviewScript(await output.text());
}

const report: ShardReport = { built: {}, failures: [] };
for (const id of ids) {
  const plan = plans.get(id);
  if (!plan) {
    report.failures.push(`${id}: no plan`);
    continue;
  }
  let used = plan;
  let code = await bundle(plan, id);
  if (
    typeof code === 'string' &&
    Buffer.byteLength(code) > PREVIEW_SCRIPT_CAP &&
    plan.examples.length > 1
  ) {
    // A live card with the first example beats a static one with all of them; when even that is
    // over the cap, the static rendition captures the whole plan, which costs nothing extra.
    const first = { id, examples: plan.examples.slice(0, 1) };
    const single = await bundle(first, `${id}.first`);
    if (single instanceof Error || Buffer.byteLength(single) <= PREVIEW_SCRIPT_CAP) {
      used = first;
      code = single;
    }
  }
  if (code instanceof Error) {
    report.failures.push(`${id}: ${code.message}`);
    continue;
  }
  const bytes = Buffer.byteLength(code);
  const file = bytes > PREVIEW_SCRIPT_CAP ? 'preview.full.js' : 'preview.js';
  mkdirSync(join(outputDirectory, id), { recursive: true });
  writeFileSync(join(outputDirectory, id, file), code);
  report.built[id] = { bytes, file, examples: used.examples.length };
}

writeFileSync(reportFile, JSON.stringify(report, null, 2));
for (const failure of report.failures) console.error(`FAIL ${failure}`);
process.exit(report.failures.length > 0 ? 1 : 0);
