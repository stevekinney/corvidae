import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { analyzeSource, isCodeFile, resolveSpecifier } from './affected-tests-graph.ts';
import { discoverWorkspaces, listTree } from './affected-tests.ts';

const root = resolve(import.meta.dir, '..');

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
    const { paths } = listTree(root);
    const workspaces = discoverWorkspaces(root);
    // Workspace source follows its `transit` dependency; the root has no workspace dependency on
    // its runner helpers, so those are the files this task must declare itself. `hang-guard.ts`
    // is the one non-root helper imported by the root process wrapper.
    const isRootHelper = (path: string) =>
      (path.startsWith('scripts/') || path === 'testing/testing/src/hang-guard.ts') &&
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
    const reachableRootHelpers = [...seen].filter(isRootHelper);
    const dynamicDomains = new Map([
      [
        'scripts/ensure-cinder-generated.ts',
        {
          fingerprint: 'bdd70cdc8bcfbd17eb3ffff4303b04df2ac0b5475855bba654cf52cc28982646',
          inputs: ['$TURBO_ROOT$/components/cinder/{src,scripts}/**'],
        },
      ],
      // Lock and process inspection are host state, not repository source inputs. A source change
      // must nevertheless reclassify the edge rather than silently retain this waiver.
      [
        'scripts/bun-test-pool.ts',
        {
          fingerprint: 'fa2fac766892996b227581718310c644f3116c137035eb7fde08e818e0b9a647',
          inputs: [],
        },
      ],
      [
        'scripts/run-exclusively.ts',
        {
          fingerprint: 'bee34a522384442da00b288488a98b59cc082204fc60227ac87eaf5307971231',
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
    if (job === 'interborough')
      expect(reachableRootHelpers).toContain('scripts/ensure-cinder-generated.ts');
    expect(unsupportedDynamicEdges, 'a root helper needs a proven bounded dynamic domain').toEqual(
      [],
    );
    expect(reachableRootHelpers.filter((path) => !covers(path)).toSorted()).toEqual([]);
    expect(inputs.some((input) => /scripts\/\*\.ts/u.test(input))).toBe(false);
    expect(command).toContain(entrypoint);
    expect(commandRoots).toContain(entrypoint);
  });
});
