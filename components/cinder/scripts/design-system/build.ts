/**
 * Builds Cinder's design system for Claude Design: a publishable `project/` folder holding the
 * token files, the brand book, a guideline page per component, and a live preview card for every
 * component with playground examples.
 *
 * Usage: bun scripts/design-system/build.ts [--out <directory>] [--note <text>]
 *
 * The folder lands in `<out>/project/` (default `tmp/cinder-design-system/out/project/`), with
 * `<out>/publish-batches.json` listing the publishes that upload it. Intermediates go to
 * `<out>/work/`. The build exits non-zero when any preview fails to build or render.
 * `components/cinder/README.md` ("Design system") explains how to republish.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { captureStaticSnapshots, checkRenders } from './browser.ts';
import {
  componentReadme,
  livePreviewHtml,
  type PreviewMeasurement,
  staticPreviewHtml,
  type StaticSnapshot,
} from './components.ts';
import { buildBundleCss } from './css.ts';
import type { ComponentManifest } from './manifest.ts';
import {
  assetsRoot,
  cinderRoot,
  defaultOutputRoot,
  examplesRoot,
  playgroundRoot,
  repositoryRoot,
} from './paths.ts';
import {
  partition,
  planPreview,
  type PreviewPlan,
  SHARD_COUNT,
  type ShardReport,
} from './previews.ts';
import { designSystemIndex, fillBrandBook, planPublishBatches } from './publish.ts';
import { buildTokens, type ResolvedContext } from './tokens.ts';

const { values: options } = parseArgs({
  args: Bun.argv.slice(2),
  options: { out: { type: 'string' }, note: { type: 'string' } },
});

const outputRoot = resolve(options.out ?? defaultOutputRoot);
const projectDirectory = join(outputRoot, 'project');
const workDirectory = join(outputRoot, 'work');
const previewsDirectory = join(workDirectory, 'previews');
const componentsDirectory = join(projectDirectory, 'components');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: repositoryRoot });
  return result.success ? result.stdout.toString().trim() : '';
}

function step(message: string): void {
  console.log(`- ${message}`);
}

/** Bundles the previews in parallel shard processes, one per shard, with ids as argv entries. */
async function buildPreviews(plans: PreviewPlan[]): Promise<ShardReport> {
  // The entry modules live in the playground so `svelte` resolves to the same copy the examples
  // import; a second copy would mount the examples with a runtime they were not compiled for.
  const entryDirectory = join(playgroundRoot, '.tmp', `design-system-entries-${process.pid}`);
  rmSync(entryDirectory, { recursive: true, force: true });
  mkdirSync(entryDirectory, { recursive: true });
  try {
    const plansFile = join(workDirectory, 'plans.json');
    writeFileSync(plansFile, JSON.stringify(plans, null, 2));
    const shards = partition(
      plans.map((plan) => plan.id),
      SHARD_COUNT,
    );
    const shardScript = join(import.meta.dir, 'preview-shard.ts');
    const outcomes = await Promise.all(
      shards.map(async (ids, index) => {
        const reportFile = join(workDirectory, `shard-${index}.json`);
        const child = Bun.spawn(
          ['bun', shardScript, plansFile, entryDirectory, previewsDirectory, reportFile, ...ids],
          // From the playground, as the original generator ran: Svelte records each component's
          // file name relative to the working directory, so this keeps the bundles byte-stable.
          { cwd: playgroundRoot, stdout: 'inherit', stderr: 'inherit' },
        );
        const exitCode = await child.exited;
        const report = existsSync(reportFile)
          ? readJson<ShardReport>(reportFile)
          : { built: {}, failures: [`shard ${index} exited ${exitCode} without a report`] };
        if (exitCode !== 0 && report.failures.length === 0) {
          report.failures.push(`shard ${index} exited ${exitCode}`);
        }
        return report;
      }),
    );
    const merged: ShardReport = { built: {}, failures: [] };
    for (const report of outcomes) {
      Object.assign(merged.built, report.built);
      merged.failures.push(...report.failures);
    }
    return merged;
  } finally {
    rmSync(entryDirectory, { recursive: true, force: true });
  }
}

/** Every file under a directory, by path relative to `root`, with its size. */
function listFiles(directory: string, root: string): Array<{ path: string; bytes: number }> {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const absolute = join(entry.parentPath, entry.name);
      return { path: relative(root, absolute), bytes: statSync(absolute).size };
    });
}

async function main(): Promise<number> {
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(componentsDirectory, { recursive: true });
  mkdirSync(previewsDirectory, { recursive: true });

  const manifest = readJson<ComponentManifest>(join(cinderRoot, 'components.json'));
  const sha = git('rev-parse', '--short=9', 'HEAD');
  if (!sha) throw new Error('could not read the current commit');

  step('tokens');
  const tokens = buildTokens({
    light: readJson<ResolvedContext>(join(cinderRoot, 'src/tokens/resolved/light.json')),
    dark: readJson<ResolvedContext>(join(cinderRoot, 'src/tokens/resolved/dark.json')),
    manifest,
    sha,
    synced: new Date().toLocaleDateString('sv'),
  });
  writeFileSync(join(projectDirectory, 'tokens.json'), JSON.stringify(tokens.document, null, 1));
  writeFileSync(join(projectDirectory, 'tokens.css'), tokens.css);
  for (const skipped of tokens.skipped) console.log(`  skipped token ${skipped}`);

  step('bundle.css');
  writeFileSync(
    join(componentsDirectory, 'bundle.css'),
    buildBundleCss(join(cinderRoot, 'src/styles/all.css')),
  );

  const plans = new Map<string, PreviewPlan>();
  for (const component of manifest.components) {
    const plan = planPreview(component.id, examplesRoot, cinderRoot);
    if (plan) plans.set(component.id, plan);
  }
  step(`previews: bundling ${plans.size} in ${SHARD_COUNT} shards`);
  const built = await buildPreviews([...plans.values()]);
  // A preview over the script cap was rebuilt with fewer examples; its card names only those.
  for (const [id, entry] of Object.entries(built.built)) {
    const plan = plans.get(id);
    if (plan) plans.set(id, { id, examples: plan.examples.slice(0, entry.examples) });
  }
  const oversized = Object.entries(built.built)
    .filter(([, entry]) => entry.file === 'preview.full.js')
    .map(([id]) => id);

  step(`static renditions: ${oversized.length}`);
  const snapshots: Map<string, StaticSnapshot> = await captureStaticSnapshots(
    previewsDirectory,
    join(componentsDirectory, 'bundle.css'),
    oversized,
  );

  const live: string[] = [];
  const staticNames: string[] = [];
  const withoutCard: string[] = [];
  const writeComponents = (measurements: Map<string, PreviewMeasurement>) => {
    for (const component of manifest.components) {
      const name = component.exportName;
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) throw new Error(`bad export name ${name}`);
      const directory = join(componentsDirectory, name);
      mkdirSync(directory, { recursive: true });
      const leaf = join(cinderRoot, 'src/components', component.id, 'README.md');
      const leafReadme = existsSync(leaf) ? readFileSync(leaf, 'utf8') : undefined;
      writeFileSync(join(directory, 'README.md'), componentReadme(component, manifest, leafReadme));
      const plan = plans.get(component.id);
      const script = join(previewsDirectory, component.id, 'preview.js');
      const snapshot = snapshots.get(component.id);
      if (plan && existsSync(script)) {
        copyFileSync(script, join(directory, 'preview.js'));
        const measurement = measurements.get(`${name}:light`);
        writeFileSync(
          join(directory, 'preview.html'),
          livePreviewHtml(component, manifest, plan, measurement),
        );
        live.push(name);
      } else if (plan && snapshot) {
        writeFileSync(
          join(directory, 'preview.html'),
          staticPreviewHtml(component, manifest, plan, snapshot),
        );
        staticNames.push(name);
      } else {
        withoutCard.push(name);
      }
    }
  };

  step('components');
  writeComponents(new Map());
  const cover = join(componentsDirectory, 'Cover');
  mkdirSync(cover, { recursive: true });
  copyFileSync(join(assetsRoot, 'cover.html'), join(cover, 'preview.html'));

  step('brand book');
  writeFileSync(
    join(projectDirectory, 'README.md'),
    fillBrandBook(readFileSync(join(assetsRoot, 'brand-book.md'), 'utf8'), {
      staticComponents: staticNames,
      componentsWithoutCard: withoutCard.length,
    }),
  );

  step(`render check: ${live.length + staticNames.length} cards in light and dark`);
  const cards = [...live, ...staticNames];
  const check = await checkRenders(projectDirectory, join(workDirectory, 'check'), cards);
  // The card heights come from the light render, so the live previews' cards are written again
  // with them; only the `@dsCard` line changes.
  live.length = 0;
  staticNames.length = 0;
  withoutCard.length = 0;
  writeComponents(check.results);

  const problems = [
    ...built.failures.map((failure) => `build ${failure}`),
    ...[...snapshots].flatMap(([id, snapshot]) =>
      snapshot.errors.map((error) => `snapshot ${id} ${error}`),
    ),
    ...check.problems.map((problem) => `render ${problem}`),
  ];
  const previewCount = live.length + staticNames.length;
  const note =
    options.note ??
    `Generated from components/cinder: ${tokens.count} tokens, ${manifest.components.length} components, ${previewCount} previews.`;
  writeFileSync(
    join(projectDirectory, 'design-system.json'),
    JSON.stringify(
      designSystemIndex({
        sha,
        author: git('config', 'user.name') || 'Corvidae',
        note,
        at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      }),
      null,
      1,
    ),
  );
  const batches = planPublishBatches(listFiles(projectDirectory, outputRoot));
  writeFileSync(join(outputRoot, 'publish-batches.json'), JSON.stringify(batches, null, 2));

  console.log(
    `\n${tokens.count} tokens, ${manifest.components.length} guideline pages, ${live.length} live previews, ${staticNames.length} static (${staticNames.join(', ')}), ${withoutCard.length} without a card.`,
  );
  console.log(`${batches.length} publishes; see ${join(outputRoot, 'publish-batches.json')}.`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} problems:`);
    for (const problem of problems) console.error(`  ${problem}`);
    return 1;
  }
  console.log(`Wrote ${projectDirectory}`);
  return 0;
}

process.exit(await main());
