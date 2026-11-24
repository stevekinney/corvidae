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
await scenarios.settled();
