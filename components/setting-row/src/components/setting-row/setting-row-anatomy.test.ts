import { setupHappyDom } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

setupHappyDom();

describe('SettingRow record-details rhythm', () => {
  test('every row is at least 44px tall, like an InspectorRow', () => {
    const css = readFileSync(new URL('./setting-row.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.cinder-setting-row \{[^}]*min-block-size: 2\.75rem/);
  });
});
