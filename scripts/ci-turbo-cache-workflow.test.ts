import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const workflowDirectory = resolve(root, '.github/workflows');
const restoreStep = './.github/actions/turbo-cache/restore';
const saveStep = './.github/actions/turbo-cache/save';

/** Scripts that start Turborepo themselves, so a job that runs them needs the cache too. */
const turboScripts = ['scripts/affected-tests.ts'];

interface Job {
  workflow: string;
  id: string;
  /** The job's lines outside comments. */
  lines: string[];
}

/** The root `package.json` scripts whose body runs Turborepo. */
function turboPackageScripts(): string[] {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  return Object.entries(manifest.scripts)
    .filter(([, body]) => /\bturbo\b/u.test(body))
    .map(([name]) => name);
}

/** Every job of every workflow that has steps (a job that only calls a workflow has none). */
function jobs(): Job[] {
  const found: Job[] = [];
  for (const workflow of readdirSync(workflowDirectory).filter((name) => name.endsWith('.yml'))) {
    const text = readFileSync(resolve(workflowDirectory, workflow), 'utf8');
    const start = text.indexOf('\njobs:\n');
    if (start === -1) continue;
    const blocks = text.slice(start + '\njobs:\n'.length).split(/\n(?=  [A-Za-z0-9_-]+:\n)/u);
    for (const block of blocks) {
      const id = /^\s*([A-Za-z0-9_-]+):\n/u.exec(block)?.[1];
      if (id === undefined || !block.includes('\n    steps:\n')) continue;
      const lines = block.split('\n').filter((line) => !line.trimStart().startsWith('#'));
      found.push({ workflow, id, lines });
    }
  }
  return found;
}

const scripts = turboPackageScripts();

/** Whether a line starts Turborepo, directly, through a root script, or through a script. */
function lineRunsTurbo(line: string): boolean {
  if (/\bturbo run\b/u.test(line)) return true;
  if (turboScripts.some((script) => line.includes(`bun ${script}`))) return true;
  const script = /\bbun run ([A-Za-z0-9:_-]+)/u.exec(line)?.[1];
  return script !== undefined && scripts.includes(script);
}

function runsTurbo(job: Job): boolean {
  return job.lines.some(lineRunsTurbo);
}

describe('Turborepo cache in the workflows', () => {
  test('finds the jobs the rule is about', () => {
    const turboJobs = jobs()
      .filter(runsTurbo)
      .map((job) => `${job.workflow}:${job.id}`);
    expect(turboJobs).toEqual(
      expect.arrayContaining([
        'main.yml:root',
        'main.yml:workspaces',
        'main.yml:tests',
        'main.yml:tests-slow',
        'browser-suites.yml:fixtures',
        'browser-suites.yml:packages',
        'browser-suites.yml:interborough',
        'pull-request.yml:static',
        'pull-request.yml:tests',
        'targeted-checks.yml:checks',
      ]),
    );
  });

  test('every job that runs Turborepo restores the cache before it and saves it last', () => {
    for (const job of jobs().filter(runsTurbo)) {
      const label = `${job.workflow}:${job.id}`;
      const restore = job.lines.findIndex((line) => line.includes(`uses: ${restoreStep}`));
      expect({ label, restored: restore !== -1 }).toEqual({ label, restored: true });
      const firstTurbo = job.lines.findIndex(lineRunsTurbo);
      expect({ label, restoreBeforeTurbo: restore < firstTurbo }).toEqual({
        label,
        restoreBeforeTurbo: true,
      });

      const save = job.lines.findIndex((line) => line.includes(`uses: ${saveStep}`));
      expect({ label, saved: save !== -1 }).toEqual({ label, saved: true });
      // The save runs after a failed step too, and is the job's last step.
      expect(job.lines[save + 1]).toContain('if: ${{ !cancelled() }}');
      expect(job.lines.slice(save + 2).some((line) => /^ {6}- /u.test(line))).toBe(false);
    }
  });

  test('every job names its cache apart from every other job', () => {
    const names = jobs()
      .filter(runsTurbo)
      .map((job) => {
        const restore = job.lines.findIndex((line) => line.includes(`uses: ${restoreStep}`));
        return /^\s+name: (.+)$/u.exec(job.lines[restore + 2] ?? '')?.[1];
      });
    expect(names.every((name) => name !== undefined)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  test('no job deletes the cache directory', () => {
    for (const job of jobs()) {
      expect(job.lines.filter((line) => /\.turbo\b|turbo prune/u.test(line))).toEqual([]);
    }
  });

  test('the cache keys a job and matrix entry to the commit, with its prefix as the fallback', () => {
    const restore = readFileSync(
      resolve(root, '.github/actions/turbo-cache/restore/action.yml'),
      'utf8',
    );
    const save = readFileSync(resolve(root, '.github/actions/turbo-cache/save/action.yml'), 'utf8');
    expect(restore).toContain('path: .turbo/cache');
    expect(restore).toContain('key: ${{ steps.key.outputs.prefix }}${{ github.sha }}');
    expect(restore).toContain('restore-keys: ${{ steps.key.outputs.prefix }}');
    expect(restore).toContain('RUNNER_OS');
    expect(save).toContain('path: .turbo/cache');
    expect(save).toContain('key: ${{ env.TURBO_CACHE_PREFIX }}${{ github.sha }}');
    // Pinned by full commit SHA, as every action is, and with no remote cache or token.
    for (const text of [restore, save]) {
      expect(text).toMatch(/uses: actions\/cache\/(restore|save)@[0-9a-f]{40} # v\d/u);
      expect(text).not.toMatch(/TURBO_TOKEN|TURBO_TEAM|TURBO_API/u);
    }
  });

  test('the root tests run through their Turborepo tasks, so a hit replays them', () => {
    const text = readFileSync(resolve(workflowDirectory, 'main.yml'), 'utf8');
    expect(text).toContain('bunx turbo run //#test:self');
    expect(text).toContain('bunx turbo run //#test:browser-fixtures');
    expect(text).not.toMatch(/^\s+- run: bun run test:(self|browser-fixtures)$/mu);
    const turbo = JSON.parse(readFileSync(resolve(root, 'turbo.json'), 'utf8')) as {
      tasks: Record<string, { outputs?: string[] }>;
    };
    // The JUnit upload and the duration check read these reports from a restored cache.
    expect(turbo.tasks['//#test:self']?.outputs).toContain('test-output/junit/self.xml');
    expect(turbo.tasks['//#test:browser-fixtures']?.outputs).toContain(
      'test-output/junit/browser-fixtures.xml',
    );
    expect(turbo.tasks['test']?.outputs).toContain('test-output/junit/**');
  });

  // The two most expensive suites: each shard replays only when its inputs, its slice and its
  // renderer are the same, so the shard and the image must stay in the task's hash.
  describe.each([
    { job: 'fixtures', task: '//#ci:browser-fixtures', script: 'ci:browser-fixtures' },
    {
      job: 'interborough',
      task: '//#ci:browser-interborough',
      script: 'ci:browser-interborough',
    },
  ])('the $job browser suite', ({ job, task, script }) => {
    const turbo = JSON.parse(readFileSync(resolve(root, 'turbo.json'), 'utf8')) as {
      tasks: Record<
        string,
        { env?: string[]; passThroughEnv?: string[]; outputs?: string[]; dependsOn?: string[] }
      >;
    };
    const definition = turbo.tasks[task];
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const workflowText = readFileSync(resolve(workflowDirectory, 'browser-suites.yml'), 'utf8');
    const jobBody = jobs().find(
      (entry) => entry.workflow === 'browser-suites.yml' && entry.id === job,
    );

    test('runs through its Turborepo task, not Playwright directly', () => {
      expect(jobBody?.lines.some((line) => line.includes(`bunx turbo run ${task}`))).toBe(true);
      expect(
        jobBody?.lines.filter((line) => /playwright test|run-gated-browser-suite/u.test(line)),
      ).toEqual([]);
    });

    test('hashes the shard, the image tag and the dependency closure', () => {
      expect(definition?.env).toEqual(
        expect.arrayContaining(['PLAYWRIGHT_SHARD', 'PLAYWRIGHT_BASE_IMAGE']),
      );
      // Never a pass-through: a pass-through is not hashed, so another shard would replay this one.
      expect(definition?.passThroughEnv ?? []).not.toContain('PLAYWRIGHT_SHARD');
      expect(definition?.passThroughEnv ?? []).not.toContain('PLAYWRIGHT_BASE_IMAGE');
      expect(definition?.dependsOn).toContain(
        `@lostgradient/${job === 'fixtures' ? 'browser-fixtures' : 'interborough'}#transit`,
      );
    });

    test('sets the shard and the image the job runs in, and the script uses the shard', () => {
      const body = jobBody?.lines.join('\n') ?? '';
      expect(body).toContain('PLAYWRIGHT_SHARD: ${{ matrix.shard }}/4');
      const image = /^\s+image: (.+)$/mu.exec(body)?.[1];
      expect(image).toBeDefined();
      expect(body).toContain(`PLAYWRIGHT_BASE_IMAGE: ${image}`);
      expect(manifest.scripts[script]).toContain('--shard=$PLAYWRIGHT_SHARD');
      expect(workflowText).toContain('name: browser-' + job + '-${{ matrix.shard }}');
    });

    test('declares the reports the artifact upload reads as outputs', () => {
      expect(definition?.outputs).toContain('playwright-output/**');
    });
  });

  test('the fixtures suite hashes its visual-diff mode and component selection', () => {
    const turbo = JSON.parse(readFileSync(resolve(root, 'turbo.json'), 'utf8')) as {
      tasks: Record<string, { env?: string[]; dependsOn?: string[] }>;
    };
    // `overview-pairs-featured-preview-and-code.playwright.ts` starts the playground's server, a
    // workspace the fixtures package does not depend on.
    expect(turbo.tasks['//#ci:browser-fixtures']?.dependsOn).toContain(
      '@lostgradient/playground#transit',
    );
    expect(turbo.tasks['//#ci:browser-fixtures']?.env).toEqual(
      expect.arrayContaining(['CINDER_VISUAL_DIFF', 'CINDER_TEST_COMPONENTS']),
    );
  });
});

describe('the remote cache shared with the owner', () => {
  const turbo = JSON.parse(readFileSync(resolve(root, 'turbo.json'), 'utf8')) as {
    tasks: Record<string, { cache?: boolean; env?: string[] }>;
  };
  const workflowsRunningTurbo = [
    ...new Set(
      jobs()
        .filter(runsTurbo)
        .map((job) => job.workflow),
    ),
  ];

  test('every workflow that runs Turborepo hands it the token and team', () => {
    const missing = workflowsRunningTurbo.filter((workflow) => {
      const text = readFileSync(resolve(workflowDirectory, workflow), 'utf8');
      return (
        !text.includes('TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}') ||
        !text.includes('TURBO_TEAM: ${{ vars.TURBO_TEAM }}')
      );
    });
    expect(missing).toEqual([]);
  });

  test('a call to a workflow that runs Turborepo passes the secrets on', () => {
    const missing: string[] = [];
    for (const workflow of readdirSync(workflowDirectory).filter((name) => name.endsWith('.yml'))) {
      const text = readFileSync(resolve(workflowDirectory, workflow), 'utf8');
      for (const match of text.matchAll(
        /uses: \.\/\.github\/workflows\/([\w.-]+)\n([\s\S]*?)\n\n/gu,
      ))
        if (workflowsRunningTurbo.includes(match[1]!) && !match[2]!.includes('secrets: inherit'))
          missing.push(`${workflow} -> ${match[1]}`);
    }
    expect(missing).toEqual([]);
  });

  // A macOS pass through the shared cache must never stand in for a Linux CI test run.
  test('every test task hashes the platform, and lint, type-check and generation do not', () => {
    const isTest = (name: string) => /^(test|ci:browser)/u.test(name.replace(/^.*#/u, ''));
    const isShared = (name: string) =>
      /^(lint|typecheck|metadata|types|transit)$/u.test(name.replace(/^.*#/u, ''));
    const unkeyed: string[] = [];
    const keyed: string[] = [];
    for (const [name, task] of Object.entries(turbo.tasks)) {
      const hashes = task.env?.includes('CORVIDAE_TEST_PLATFORM') ?? false;
      if (isTest(name) && task.cache !== false && !hashes) unkeyed.push(name);
      if (isShared(name) && hashes) keyed.push(name);
    }
    expect(unkeyed).toEqual([]);
    expect(keyed).toEqual([]);
  });

  test('the cache restore step sets the platform every test task hashes', () => {
    const action = readFileSync(
      resolve(root, '.github/actions/turbo-cache/restore/action.yml'),
      'utf8',
    );
    expect(action).toContain('CORVIDAE_TEST_PLATFORM=${RUNNER_OS}-${RUNNER_ARCH}');
  });
});
