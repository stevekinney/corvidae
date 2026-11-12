import { describe, expect, test } from 'bun:test';
import { mainCiHealth, mainCiWarning, renderMainCiHealth } from './main-ci.ts';
import type { Runner } from './process-runner.ts';

const runs = (stdout: string, code = 0, stderr = ''): Runner => () => ({ code, stdout, stderr });
const run = (conclusion: string) =>
  JSON.stringify([{ conclusion, headSha: 'f'.repeat(40), url: 'https://x.test/1', createdAt: 't' }]);

describe('mainCiHealth', () => {
  test.each(['failure', 'timed_out', 'startup_failure'])('%s is red', (conclusion) => {
    const health = mainCiHealth(runs(run(conclusion)), 'o/n', 'main');
    expect(health.red).toBe(true);
    expect(mainCiWarning(health, 'main')).toContain('RED');
  });

  test.each(['success', 'neutral'])('%s is not red', (conclusion) => {
    const health = mainCiHealth(runs(run(conclusion)), 'o/n', 'main');
    expect(health.red).toBe(false);
    expect(mainCiWarning(health, 'main')).toBeUndefined();
  });

  test('a cancelled run is skipped over: the newest conclusive run decides', () => {
    const list = (...conclusions: string[]) =>
      JSON.stringify(conclusions.map((conclusion) => ({ conclusion, headSha: 'a', url: 'u', createdAt: 't' })));
    expect(mainCiHealth(runs(list('cancelled', 'failure', 'success')), 'o/n', 'main').red).toBe(true);
    expect(mainCiHealth(runs(list('cancelled', 'success', 'failure')), 'o/n', 'main').red).toBe(false);
    expect(mainCiWarning(mainCiHealth(runs(list('cancelled', 'skipped')), 'o/n', 'main'), 'main')).toContain(
      'main health unknown',
    );
  });

  test('a runner that throws is unknown', () => {
    const runner: Runner = () => {
      throw new Error('spawn gh ENOENT');
    };
    expect(mainCiWarning(mainCiHealth(runner, 'o/n', 'main'), 'main')).toContain('main health unknown');
  });

  test('a failed read is unknown, with the reason', () => {
    const health = mainCiHealth(runs('', 1, 'no network\nmore'), 'o/n', 'main');
    expect(health.red).toBe(false);
    expect(renderMainCiHealth(health, 'main')).toBe(
      'main health unknown: gh run list failed (exit 1): no network.',
    );
  });

  test.each(['not json', '{}', '[]', '[{"conclusion":null}]'])('%s is unknown', (stdout) => {
    const health = mainCiHealth(runs(stdout), 'o/n', 'main');
    expect(health.red).toBe(false);
    expect(mainCiWarning(health, 'main')).toContain('main health unknown');
  });
});
