import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { FailureCategory } from '@lostgradient/weft/testing';

import * as failureCategory from './failure-category.ts';
import { failureCategoryLabel, failureCategoryTone } from './failure-category.ts';

const ALL_CATEGORIES: readonly FailureCategory[] = [
  'application',
  'timeout',
  'cancellation',
  'resource',
  'system',
];

describe('the failure category module (COR-2533)', () => {
  test('AC2: exports only the badge’s label and tone, so the browser words no explanation', () => {
    expect(Object.keys(failureCategory).toSorted()).toEqual([
      'failureCategoryLabel',
      'failureCategoryTone',
    ]);
  });

  test('AC2: its documentation names only files that exist', async () => {
    const path = join(import.meta.dir, 'failure-category.ts');
    const source = await Bun.file(path).text();
    const documentation = source.slice(0, source.indexOf('*/'));
    const named = [...documentation.matchAll(/`([\w./-]+\.(?:svelte|ts))`/gu)].map(
      (match) => match[1]!,
    );
    // The module names the component that draws the explanation, so a rename cannot orphan it.
    expect(named).toContain('run-failure-explanation.svelte');
    const folders = [dirname(path), join(dirname(path), '..', 'runs')];
    for (const file of named) {
      expect(
        folders.some((folder) => existsSync(join(folder, file))),
        `${file} is named in the module documentation and does not exist`,
      ).toBe(true);
    }
  });
});

describe('failureCategoryLabel', () => {
  test('labels every real category verbatim', () => {
    for (const category of ALL_CATEGORIES) {
      expect(failureCategoryLabel(category)).toBe(category);
    }
  });

  test('null renders as "uncategorized"', () => {
    expect(failureCategoryLabel(null)).toBe('uncategorized');
  });

  test('undefined renders as empty string', () => {
    expect(failureCategoryLabel(undefined)).toBe('');
  });
});

describe('failureCategoryTone', () => {
  test('reads a cancellation quietly, a limit as a warning, and a fault as danger', () => {
    expect(failureCategoryTone('cancellation')).toBe('neutral');
    expect(failureCategoryTone('timeout')).toBe('warning');
    expect(failureCategoryTone('resource')).toBe('warning');
    expect(failureCategoryTone('application')).toBe('danger');
    expect(failureCategoryTone('system')).toBe('danger');
  });

  test('a failure nothing classifies is danger, and every category has a tone', () => {
    expect(failureCategoryTone(null)).toBe('danger');
    for (const category of ALL_CATEGORIES) {
      expect(failureCategoryTone(category)).toMatch(/^(neutral|warning|danger)$/u);
    }
  });
});
