import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { WORKER_INHERITANCE_RULES } from './worker-inheritance-rules.ts';

const REPOSITORY_ROOT = resolve(import.meta.dir, '../../../..');

describe('worker inheritance rules', () => {
  test.each(Object.values(WORKER_INHERITANCE_RULES))(
    'the $surface rule names Weft sources that exist',
    (rule) => {
      expect(rule.sources.length).toBeGreaterThan(0);
      for (const source of rule.sources) {
        expect(existsSync(resolve(REPOSITORY_ROOT, source))).toBe(true);
      }
    },
  );

  test('the rules cover every surface and key by their own surface', () => {
    expect(Object.keys(WORKER_INHERITANCE_RULES).toSorted()).toEqual([
      'activity',
      'child',
      'fork',
      'restart',
      'schedule',
      'start',
    ]);
    const surfaces: string[] = Object.values(WORKER_INHERITANCE_RULES).map((rule) => rule.surface);
    expect(surfaces.toSorted()).toEqual(Object.keys(WORKER_INHERITANCE_RULES).toSorted());
  });

  test('the child rule is the one the child-inheritance test proves', () => {
    const test = readFileSync(
      resolve(
        REPOSITORY_ROOT,
        'packages/weft/src/core/engine/worker-versioning-child-inheritance.test.ts',
      ),
      'utf8',
    );
    expect(test).toContain(
      'inherits a same-revision parent worker binding for ctx.startChild starts',
    );
  });

  test('the fork rule is the one the policy test proves', () => {
    const test = readFileSync(
      resolve(REPOSITORY_ROOT, 'packages/weft/src/core/engine/worker-versioning-policy.test.ts'),
      'utf8',
    );
    expect(test).toContain(
      'does not inherit a source worker binding when an explicit fork revision differs',
    );
    expect(test).toContain('inherits the terminal worker binding for no-preview start-new retries');
  });
});
