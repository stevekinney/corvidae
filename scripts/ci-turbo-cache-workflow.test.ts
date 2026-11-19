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
    expect(turbo.tasks.test?.outputs).toContain('test-output/junit/**');
  });
});
