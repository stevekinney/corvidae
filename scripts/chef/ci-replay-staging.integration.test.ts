import { expect } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import { rootScriptEnvironment } from '../environment-configuration.ts';
import { createScenarios } from './scenario.test-support.ts';

const scenarios = createScenarios();
for (const workflow of ['targeted-checks.yml', 'pull-request.yml', 'browser-suites.yml']) {
  scenarios.scenario(
    `${workflow} stages only the allowlisted reports and fails closed on collisions and symlinks`,
    async () => {
      const yaml = Bun.YAML.parse(
        readFileSync(resolve(import.meta.dir, '../../.github/workflows', workflow), 'utf8'),
      ) as { env: Record<string, string> };
      const stage = yaml.env['CI_REPLAY_STAGE']!;
      const directory = mkdtempSync(join(tmpdir(), 'ci-replay-stage-'));
      const run = async () => {
        const result = await runWithHangGuard(['bash', '-c', stage], {
          env: { ...rootScriptEnvironment(), RUNNER_TEMP: directory },
        });
        return result.exitCode;
      };
      try {
        const record = {
          head: 'abc',
          digest: 'sha256-example',
          assertion: { matcher: 'toBe' },
          artifacts: { junit: { link: 'ci-replay-junit.xml', reason: null } },
        };
        const writeRecord = () =>
          writeFileSync(join(directory, 'ci-replay-record.json'), JSON.stringify(record, null, 2));
        writeRecord();
        writeFileSync(join(directory, 'ci-replay-junit.xml'), '<testsuite/>');
        writeFileSync(join(directory, 'ci-replay-junit-raw.xml'), 'harmless-private-marker');
        writeFileSync(join(directory, 'unexpected-secret'), 'harmless-private-marker');
        expect(await run()).toBe(0);
        const staged = join(directory, 'ci-replay-artifact');
        expect(readdirSync(staged).toSorted()).toEqual([
          'ci-replay-junit.xml',
          'ci-replay-record.json',
        ]);
        for (const name of readdirSync(staged))
          expect(readFileSync(join(staged, name), 'utf8')).not.toContain('harmless-private-marker');
        expect(await run()).not.toBe(0);
        rmSync(staged, { recursive: true });
        rmSync(join(directory, 'ci-replay-junit.xml'));
        expect(await run()).toBe(0);
        expect(readdirSync(staged)).toEqual(['ci-replay-record.json']);
        const unavailable = JSON.parse(readFileSync(join(staged, 'ci-replay-record.json'), 'utf8'));
        expect(unavailable.head).toBe('abc');
        expect(unavailable.digest).toBe('sha256-example');
        expect(unavailable.assertion).toEqual({ matcher: 'toBe' });
        expect(unavailable.artifacts.junit).toEqual({
          link: null,
          reason: 'sanitized JUnit unavailable at staging',
        });
        rmSync(staged, { recursive: true });
        writeFileSync(
          join(directory, 'ci-replay-record.json'),
          JSON.stringify(
            { ...record, artifacts: { junit: { link: null, reason: 'not emitted' } } },
            null,
            2,
          ),
        );
        expect(await run()).toBe(0);
        expect(readdirSync(staged)).toEqual(['ci-replay-record.json']);
        rmSync(staged, { recursive: true });
        writeRecord();
        symlinkSync(
          join(directory, 'ci-replay-junit-raw.xml'),
          join(directory, 'ci-replay-junit.xml'),
        );
        expect(await run()).toBe(0);
        expect(readdirSync(staged)).toEqual(['ci-replay-record.json']);
        expect(
          JSON.parse(readFileSync(join(staged, 'ci-replay-record.json'), 'utf8')).artifacts.junit
            .link,
        ).toBeNull();
        rmSync(staged, { recursive: true });
        rmSync(join(directory, 'ci-replay-record.json'));
        symlinkSync(join(directory, 'unexpected-secret'), join(directory, 'ci-replay-record.json'));
        expect(await run()).not.toBe(0);
        rmSync(staged, { recursive: true });
        mkdirSync(staged);
        expect(await run()).not.toBe(0);
        rmSync(staged, { recursive: true });
        rmSync(join(directory, 'ci-replay-record.json'));
        rmSync(join(directory, 'ci-replay-junit.xml'));
        expect(await run()).not.toBe(0);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
}
scenarios.scenario(
  'captures the fetched selection commit separately from the event base',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ci-replay-selection-'));
    const environment = {
      ...rootScriptEnvironment(),
      GIT_AUTHOR_NAME: 'Replay Test',
      GIT_AUTHOR_EMAIL: 'replay@example.test',
      GIT_COMMITTER_NAME: 'Replay Test',
      GIT_COMMITTER_EMAIL: 'replay@example.test',
    };
    const git = async (...args: string[]) => {
      const result = await runWithHangGuard(['git', ...args], { cwd: directory, env: environment });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    try {
      await git('init', '--quiet');
      writeFileSync(join(directory, 'bun.lock'), 'fixture');
      await git('add', 'bun.lock');
      await git('commit', '--quiet', '-m', 'event base');
      const eventBase = await git('rev-parse', 'HEAD');
      writeFileSync(join(directory, 'bun.lock'), 'advanced');
      await git('add', 'bun.lock');
      await git('commit', '--quiet', '-m', 'selection base');
      const selectionBase = await git('rev-parse', 'HEAD');
      await git('update-ref', 'refs/remotes/origin/main', selectionBase);
      const temporary = join(directory, 'scratch');
      mkdirSync(temporary);
      writeFileSync(
        join(directory, 'mutate-ref.sh'),
        'git update-ref refs/remotes/origin/main "$CI_REPLAY_BASE"\nexit 1\n',
      );
      const result = await runWithHangGuard(
        ['bun', resolve(import.meta.dir, 'ci-replay.ts'), 'run', '--', 'bash', 'mutate-ref.sh'],
        {
          cwd: directory,
          env: {
            ...environment,
            RUNNER_TEMP: temporary,
            GITHUB_WORKSPACE: directory,
            GITHUB_RUN_ID: '1',
            GITHUB_RUN_ATTEMPT: '1',
            GITHUB_JOB: 'tests',
            GITHUB_SHA: selectionBase,
            CI_REPLAY_HEAD: selectionBase,
            CI_REPLAY_BASE: eventBase,
            TURBO_SCM_BASE: 'origin/main',
          },
        },
      );
      expect(result.exitCode).toBe(1);
      const record = JSON.parse(readFileSync(join(temporary, 'ci-replay-record.json'), 'utf8'));
      expect(record.base).toBe(eventBase);
      expect(record.selectionBase).toBe(selectionBase);
      expect(record.selectionBaseUnavailable).toBeNull();
      expect(await git('rev-parse', 'origin/main')).toBe(eventBase);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
await scenarios.settled();
