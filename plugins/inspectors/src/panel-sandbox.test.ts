import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Glob } from 'bun';

/**
 * Every host frames a panel with `sandbox="allow-scripts"` and nothing else (the chat README, the
 * reference host, the run page), and a sandboxed frame without `allow-forms` never submits a form.
 * A panel that saves from a submit button therefore saves nothing in any real host, while a unit
 * test that dispatches `submit` itself still passes (COR-2545). No panel relies on it.
 */
describe('a panel in its sandboxed frame', () => {
  it('saves from a button of its own, never from a form submitting', async () => {
    const pluginsDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const offences: string[] = [];
    let scanned = 0;
    for await (const path of new Glob('*/src/**/*.svelte').scan({
      cwd: pluginsDirectory,
      absolute: true,
    })) {
      scanned += 1;
      const text = await readFile(path, 'utf8');
      if (/type=["']submit["']/.test(text))
        offences.push(`${relative(pluginsDirectory, path)}: a submit button`);
      if (/onsubmit=\{[^}]*on[A-Z]\w*\(/.test(text)) {
        offences.push(`${relative(pluginsDirectory, path)}: work done in onsubmit`);
      }
    }
    expect(scanned).toBeGreaterThan(3);
    expect(offences).toEqual([]);
  });
});
