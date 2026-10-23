import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newPacket, packetFile, packetStatus, renderStatus, run } from './packet.ts';
import { UsageError, type Runner } from './process-runner.ts';

const sha = 'a'.repeat(40);
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'packet-'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function fake(log: string) {
  const calls: string[][] = [];
  const runner: Runner = (command) => {
    calls.push(command);
    if (command[1] === 'rev-parse') return { code: 0, stdout: `${sha}\n`, stderr: '' };
    if (command[1] === 'log') return { code: 0, stdout: log, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

describe('packets', () => {
  test('new writes a skeleton with the base and paths, and refuses to overwrite', () => {
    const { runner } = fake('');
    const now = new Date('2026-10-23T00:00:00.000Z');
    const file = newPacket(runner, directory, 'chef', ['scripts/chef/a.ts'], 'main', now);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain(`Base: ${sha}`);
    expect(text).toContain('Written: 2026-10-23T00:00:00.000Z');
    expect(text).toContain('- `scripts/chef/a.ts`');
    expect(() => newPacket(runner, directory, 'chef', [], 'main')).toThrow(UsageError);
  });

  test('status lists commits since the base that touched the paths, and is stale', () => {
    const { runner, calls } = fake('abc1234 Change a (#1)\n');
    newPacket(runner, directory, 'chef', ['scripts/chef/a.ts:10', 'scripts/chef/b.ts'], 'main');
    const status = packetStatus(
      runner,
      directory,
      'chef',
      'main',
      new Date(Date.now() + 7_200_000),
    );
    expect(status.stale).toBe(true);
    expect(status.commits).toEqual(['abc1234 Change a (#1)']);
    expect(status.ageHours).toBeGreaterThan(1.9);
    const log = calls.find((call) => call[1] === 'log') ?? [];
    expect(log).toContain(`${sha}..origin/main`);
    expect(log.slice(log.indexOf('--') + 1)).toEqual(['scripts/chef/a.ts', 'scripts/chef/b.ts']);
    expect(renderStatus(status)).toContain('STALE');
  });

  test('status is fresh when nothing touched the paths, and falls back to the written time', () => {
    const { runner, calls } = fake('');
    writeFileSync(
      packetFile(directory, 'old'),
      '# Packet\n\nWritten: 2026-10-01T00:00:00.000Z\n\n## Paths\n\n- `src/x/y.ts`\n',
    );
    const status = packetStatus(runner, directory, 'old', 'main');
    expect(status.stale).toBe(false);
    expect(calls.find((call) => call[1] === 'log')).toContain('--since=2026-10-01T00:00:00.000Z');
    expect(renderStatus(status)).toContain('fresh');
  });

  test('run reports exit 1 for a stale packet, and rejects a bad area or a missing packet', () => {
    const { runner } = fake('abc1234 Touch\n');
    const config = join(import.meta.dir, 'repository.json');
    newPacket(runner, directory, 'chef', ['scripts/chef/a.ts'], 'main');
    expect(run(['status', 'chef', '--dir', directory, '--config', config], runner).code).toBe(1);
    expect(() => run(['status', '../x', '--dir', directory], runner)).toThrow(UsageError);
    expect(() =>
      run(['status', 'missing', '--dir', directory, '--config', config], runner),
    ).toThrow(UsageError);
    expect(existsSync(packetFile(directory, 'chef'))).toBe(true);
  });
});
