/**
 * "Every example mounts", for one component package (COR-2081).
 *
 * A package's examples live beside each component, in `src/**\/examples/*.example.svelte`. A
 * package runs this from one test file, `src/examples.test.ts`, which `create-package.ts`,
 * `extract-families.ts` and the playground's examples move write (`scripts/example-mount-tests.ts`):
 *
 * ```ts
 * import { mountEveryExample } from '@lostgradient/component-tooling/test/example-mounts.ts';
 *
 * mountEveryExample(import.meta.dir);
 * ```
 *
 * Each example gets one test that mounts it into the document the package's test preload provides,
 * lets its effects and the next microtasks run, and unmounts it. The test fails when the import,
 * the mount, an effect or the unmount throws, or when anything writes to `console.error` meanwhile.
 */

import { describe, expect, test } from 'bun:test';
import { relative, sep } from 'node:path';

import { flushSync, mount, tick, unmount, type Component } from 'svelte';

import { exampleFiles } from '../../scripts/lib/example-files.ts';

export { exampleFiles };

function describeError(value: unknown): string {
  return value instanceof Error ? (value.stack ?? value.message) : String(value);
}

/** Mount one example, let it settle, unmount it; return every `console.error` call meanwhile. */
export async function mountExample(file: string): Promise<string[]> {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => {
    errors.push(values.map(describeError).join(' '));
  };
  const target = document.createElement('div');
  document.body.append(target);
  try {
    const module = (await import(file)) as { default: Component };
    const instance = mount(module.default, { target });
    flushSync();
    await tick();
    flushSync();
    await unmount(instance);
  } finally {
    target.remove();
    console.error = originalError;
  }
  return errors;
}

/** Register one test per example under `sourceDirectory`, each failing on an error it raises. */
export function mountEveryExample(sourceDirectory: string): void {
  const files = exampleFiles(sourceDirectory);
  describe('every example mounts', () => {
    if (files.length === 0) {
      test('has no examples to mount', () => {
        expect(files).toEqual([]);
      });
      return;
    }
    for (const file of files) {
      test(relative(sourceDirectory, file).split(sep).join('/'), async () => {
        expect(await mountExample(file)).toEqual([]);
      });
    }
  });
}
