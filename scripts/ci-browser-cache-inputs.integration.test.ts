import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { runWithHangGuard } from '../testing/testing/src/hang-guard.ts';
import { analyzeSource, isCodeFile, resolveSpecifier } from './affected-tests-graph.ts';
import { discoverWorkspaces } from './affected-tests.ts';

const root = resolve(import.meta.dir, '..');
const ENSURE_CINDER_GENERATED = 'components/cinder/scripts/ensure-cinder-generated.ts';
const listing = await runWithHangGuard([
  'git',
  '-C',
  root,
  'ls-files',
  '-z',
  '--cached',
  '--others',
  '--exclude-standard',
]);
if (listing.exitCode !== 0) throw new Error(listing.stderr.toString());
const paths = new Set(
  listing.stdout
    .toString()
    .split('\0')
    .filter((path) => path.length > 0 && existsSync(resolve(root, path))),
);
const workspaces = discoverWorkspaces(root);
const dryRun = await runWithHangGuard(
  [
    resolve(root, 'node_modules/.bin/turbo'),
    'run',
    'ci:browser-fixtures',
    'ci:browser-interborough',
    '--dry=json',
    '--cache=local:r',
  ],
  { cwd: root },
);
if (dryRun.exitCode !== 0) throw new Error(dryRun.stderr.toString());
const plan = JSON.parse(dryRun.stdout.toString()) as {
  tasks: { taskId: string; dependencies: string[]; inputs: Record<string, string> }[];
};
const plannedTask = (id: string) => {
  const task = plan.tasks.find((entry) => entry.taskId === id);
  if (task === undefined) throw new Error(`Turbo did not plan ${id}`);
  return task;
};

describe.each([
  { job: 'fixtures', task: '//#ci:browser-fixtures', script: 'ci:browser-fixtures' },
  {
    job: 'interborough',
    task: '//#ci:browser-interborough',
    script: 'ci:browser-interborough',
  },
])('the $job browser suite cache inputs', ({ job, task, script }) => {
  test('key every reachable root helper without keying unrelated root tooling', () => {
    const configuration = JSON.parse(readFileSync(resolve(root, 'turbo.json'), 'utf8')) as {
      tasks: Record<string, { inputs?: string[] }>;
    };
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const command = manifest.scripts[script];
    if (command === undefined) throw new Error(`missing root script ${script}`);
    const directory =
      job === 'fixtures' ? 'scripts/browser-fixtures/' : 'applications/interborough/';
    const entrypoint =
      job === 'fixtures'
        ? 'scripts/browser-fixtures/scripts/prepare-manifest.ts'
        : 'applications/interborough/scripts/run-gated-browser-suite.ts';
    // Workspace source follows its `transit` dependency; the root has no workspace dependency on
    // its runner helpers, so those are the files this task must declare itself. `hang-guard.ts`
    // is the one non-root helper imported by the root process wrapper, and the process ownership
    // library is another: the root scripts import its lease, group and lock primitives. Cinder's
    // `ensure-cinder-generated.ts` is owned by Cinder, but the browser tasks reach it and through it
    // the root process helpers, so the walk treats it like a root helper.
    const isRootHelper = (path: string) =>
      (path.startsWith('scripts/') ||
        path === 'testing/testing/src/hang-guard.ts' ||
        path === ENSURE_CINDER_GENERATED ||
        (path.startsWith('packages/process-lease/src/') &&
          !/\.test(?:-support)?\.ts$/u.test(path))) &&
      isCodeFile(path);
    const seen = new Set<string>();
    // Playwright loads its config, collected specs, web-server and application source at run time.
    // Ordinary Bun tests and unrelated package scripts are not browser runtime roots.
    const browserRuntimeRoots = [...paths].filter((path) => {
      if (!isCodeFile(path)) return false;
      if (job === 'fixtures')
        return (
          path === 'scripts/browser-fixtures/playwright.config.ts' ||
          path === 'scripts/browser-fixtures/scripts/prepare-manifest.ts' ||
          path === 'scripts/browser-fixtures/scripts/build.ts' ||
          path === 'scripts/browser-fixtures/scripts/serve.ts' ||
          path.startsWith('scripts/browser-fixtures/src/') ||
          (path.endsWith('.playwright.ts') && path.startsWith('scripts/browser-fixtures/tests/'))
        );
      return (
        path === 'applications/interborough/playwright.config.ts' ||
        path === 'applications/interborough/tests/e2e/e2e-server.ts' ||
        path === 'applications/interborough/scripts/build.ts' ||
        path.startsWith('applications/interborough/src/') ||
        (path.endsWith('.spec.ts') &&
          (path.startsWith('applications/interborough/tests/e2e/') ||
            path.startsWith('applications/interborough/tests/panels/')))
      );
    });
    const commandRoots = command
      .split(/[\s&|;'"\\]+/u)
      .filter((token) => paths.has(token) && isCodeFile(token));
    const pending = [...new Set([...commandRoots, ...browserRuntimeRoots])];
    const unsupportedDynamicEdges: string[] = [];
    const dynamicRootHelpers = new Set<string>();
    for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
      if (seen.has(current)) continue;
      seen.add(current);
      const analysis = analyzeSource(current, readFileSync(resolve(root, current), 'utf8'));
      if (
        !current.startsWith(directory) &&
        (analysis.importsDynamically || analysis.bundlesCode || analysis.scansRepository)
      ) {
        unsupportedDynamicEdges.push(current);
      }
      if (!current.startsWith(directory) && analysis.scansFileSystem)
        dynamicRootHelpers.add(current);
      for (const specifier of analysis.specifiers) {
        const target = resolveSpecifier(current, specifier, paths, workspaces);
        if (target !== null && (target.startsWith(directory) || isRootHelper(target)))
          pending.push(target);
      }
    }
    const inputs = configuration.tasks[task]?.inputs ?? [];
    const covers = (path: string) =>
      inputs.some((input) => {
        if (input.startsWith('!')) return false;
        const normalized = input.replace(/^\$TURBO_ROOT\$\//u, '');
        return normalized === path || new Bun.Glob(normalized).match(path);
      });
    // This must be the positive suite-wide input. The exclusions below it deliberately match the
    // directory too, and do not invalidate the cache when a runtime file changes.
    expect(inputs).toContain(`$TURBO_ROOT$/${directory}**`);
    expect(covers(entrypoint)).toBe(true);
    expect(Object.hasOwn(plannedTask(task).inputs, directory + 'playwright.config.ts')).toBe(true);
    const reachableRootHelpers = [...seen].filter(isRootHelper);
    const dynamicDomains = new Map([
      [
        ENSURE_CINDER_GENERATED,
        {
          // The helper walks Cinder's `src` and `scripts`, and reads the root `workspaces` and the
          // workspace manifests they list only to find the one named `@lostgradient/cinder`.
          fingerprint: '717730156d1ee877d2e21febd9340b24f6784aea8419b23eee78358bd352cf4f',
          inputs: [
            '$TURBO_ROOT$/components/cinder/{src,scripts}/**',
            '$TURBO_ROOT$/package.json',
            '$TURBO_ROOT$/bun.lock',
          ],
        },
      ],
      // The lease scans pending ownership records in the local lock directory, not source files.
      [
        'packages/process-lease/src/owned-process-lease.ts',
        {
          fingerprint: '72c042ee3e3f8289aad77b48f89e5d1b6fcaeddce01e59942a10a3b5157c5c06',
          inputs: [],
        },
      ],
      // Lock and process inspection are host state, not repository source inputs. A source change
      // must nevertheless reclassify the edge rather than silently retain this waiver.
      [
        'scripts/bun-test-pool.ts',
        {
          fingerprint: 'f0e6863d1cbe8a500723851f082f63c6290751fbe7257c1b8b1fdc001fc07e39',
          inputs: [],
        },
      ],
      [
        'packages/process-lease/src/reclaim.ts',
        {
          fingerprint: 'eefe51d37564a021376c0c579f32a78c2e24aaddbe376e454ecb80f7d018e824',
          inputs: [],
        },
      ],
      [
        'scripts/run-exclusively.ts',
        {
          fingerprint: 'b488e2c1ac6dd5ab2172944fb6c9319d54e4d00fc91405705c3ed5e5fed19ae2',
          inputs: [],
        },
      ],
      [
        'scripts/test-watchdog.ts',
        {
          fingerprint: 'f2b2a60c6ea53cbaafdb8394f2647cb7d37c81621df997c16f77b2bbaebfb951',
          inputs: [],
        },
      ],
    ]);
    for (const path of dynamicRootHelpers) {
      const classification = dynamicDomains.get(path);
      if (classification === undefined)
        throw new Error(`${path} has no proven dynamic input domain`);
      const fingerprint = new Bun.CryptoHasher('sha256')
        .update(readFileSync(resolve(root, path), 'utf8'))
        .digest('hex');
      expect(fingerprint, `${path} dynamic classification drifted`).toBe(
        classification.fingerprint,
      );
      for (const input of classification.inputs) expect(inputs).toContain(input);
    }
    if (dynamicRootHelpers.has(ENSURE_CINDER_GENERATED)) {
      // The Cinder metadata task keys tooling sources and its own manifest. Its transit dependency
      // keys the tooling manifest. Verify the effective Turbo graph for both suite entrypoints.
      const workspace = job === 'fixtures' ? 'browser-fixtures' : 'interborough';
      const suite = plannedTask(task);
      const metadata = plannedTask(`@lostgradient/${workspace}#metadata`);
      const cinder = plannedTask('@lostgradient/cinder#metadata');
      const transit = plannedTask('@lostgradient/cinder#transit');
      const tooling = plannedTask('@lostgradient/component-tooling#transit');
      expect(suite.dependencies).toContain(metadata.taskId);
      expect(metadata.dependencies).toContain(cinder.taskId);
      expect(cinder.dependencies).toContain(transit.taskId);
      expect(transit.dependencies).toContain(tooling.taskId);
      expect(Object.hasOwn(cinder.inputs, 'package.json')).toBe(true);
      expect(
        Object.hasOwn(
          cinder.inputs,
          '../../internal/component-tooling/scripts/generate-component-artifacts.ts',
        ),
      ).toBe(true);
      expect(
        Object.hasOwn(cinder.inputs, '../../internal/component-tooling/src/schema-types.ts'),
      ).toBe(true);
      expect(Object.hasOwn(tooling.inputs, 'package.json')).toBe(true);
      for (const path of paths) {
        if (
          !/^internal\/component-tooling\/(?:scripts|src)\//u.test(path) ||
          /\.test\.[cm]?[jt]s$/u.test(path)
        )
          continue;
        const input = relative('components/cinder', path).split(sep).join('/');
        expect(Object.hasOwn(cinder.inputs, input), `${path} is absent from Cinder metadata`).toBe(
          true,
        );
      }
      const metadataInputs = configuration.tasks['metadata']?.inputs ?? [];
      expect(metadataInputs).toContain('$TURBO_ROOT$/internal/component-tooling/scripts/**');
      expect(metadataInputs).toContain('$TURBO_ROOT$/internal/component-tooling/src/**');
    }
    expect(reachableRootHelpers).toContain(ENSURE_CINDER_GENERATED);
    // The group starts this fixed executable by path, which the static import graph cannot see.
    if (reachableRootHelpers.includes('packages/process-lease/src/owned-process-group.ts')) {
      const group = readFileSync(
        resolve(root, 'packages/process-lease/src/owned-process-group.ts'),
        'utf8',
      );
      expect(new Bun.CryptoHasher('sha256').update(group).digest('hex')).toBe(
        'b56d6ad0da72e5b4b2645b0dc9ae6c767ff0a77676f72d3d09a3a6db84fdb81d',
      );
      expect(group).toContain("join(import.meta.dir, 'owned-process-gate.ts')");
      expect(covers('packages/process-lease/src/owned-process-gate.ts')).toBe(true);
    }
    expect(unsupportedDynamicEdges, 'a root helper needs a proven bounded dynamic domain').toEqual(
      [],
    );
    expect(reachableRootHelpers.filter((path) => !covers(path)).toSorted()).toEqual([]);
    expect(inputs.some((input) => /scripts\/\*\.ts/u.test(input))).toBe(false);
    expect(command).toContain(entrypoint);
    expect(commandRoots).toContain(entrypoint);
  });
});
