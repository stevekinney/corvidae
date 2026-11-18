import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cinderComponentFile } from '@lostgradient/component-tooling/scripts/discover-component-directories.ts';

/** A component's file, wherever the split put the component (P-COR-101). */
const componentFile = (path: string) => cinderComponentFile(path);

describe('shared label/value hierarchy', () => {
  test('defines every axis of the shared hierarchy', () => {
    const css = readFileSync(
      resolve(import.meta.dir, '../../../../foundation/src/styles/components/_label-value.css'),
      'utf8',
    );

    expect(css).toContain('color: var(--cinder-text-default);');
    expect(css).toContain('font-size: var(--cinder-text-base);');
    expect(css).toContain('font-weight: var(--cinder-font-semibold);');
    expect(css).toContain('line-height: var(--cinder-leading-snug);');
    expect(css).toContain('color: var(--cinder-text-muted);');
    expect(css).toContain('font-size: var(--cinder-text-sm);');
    expect(css).toContain('font-weight: var(--cinder-font-normal);');
    expect(css).toContain('line-height: var(--cinder-leading-normal);');
  });

  test.each([
    ['access-gate/access-gate.svelte', 'cinder-_label-text', 'cinder-_value-text'],
    ['capability-gate/capability-gate.svelte', 'cinder-_label-text', 'cinder-_value-text'],
    ['description-list/description-list.svelte', 'cinder-_label-text', 'cinder-_value-text'],
    ['footer/footer.svelte', 'cinder-_label-text', 'cinder-_value-text'],
  ])('%s composes the shared label and value roles', (relativePath, labelClass, valueClass) => {
    const source = readFileSync(componentFile(relativePath), 'utf8');

    expect(source).toContain(labelClass);
    expect(source).toContain(valueClass);
  });
});
