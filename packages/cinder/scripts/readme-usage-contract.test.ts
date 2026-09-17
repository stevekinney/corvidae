import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverReadmeComponents, toIdentifier } from './readme-usage-contract.ts';

describe('README usage discovery', () => {
  test('skips private and icon directories and descends into experimental', () => {
    const root = mkdtempSync(join(tmpdir(), 'cinder-readme-contract-'));
    try {
      mkdirSync(join(root, '_private'), { recursive: true });
      mkdirSync(join(root, 'icons'), { recursive: true });
      mkdirSync(join(root, 'experimental', 'new-card'), { recursive: true });
      mkdirSync(join(root, 'button'), { recursive: true });
      writeFileSync(join(root, 'experimental', 'new-card', 'README.md'), '# NewCard');
      writeFileSync(join(root, 'button', 'README.md'), '# Button');
      expect(discoverReadmeComponents(root).map(({ componentId }) => componentId)).toEqual([
        'button',
        'new-card',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('converts component ids to the expected Svelte tag name', () => {
    expect(toIdentifier('date-range-picker')).toBe('DateRangePicker');
  });
});
