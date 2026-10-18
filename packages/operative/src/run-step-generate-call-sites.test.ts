/**
 * COR-716 — the admission invariant is only as strong as the set of paths to the
 * run's `generate`. This guard pins that set: the step loop reaches
 * `deps.generate` through `callGenerateWithRetry` alone (where the binding
 * admission and the mutated-retry derivation live), and the two
 * `onMaximumSteps` tails derive `resolvedSources` before handing the handler
 * its context. A new path to `generate` must either go through one of these or
 * be added here with its own derivation.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

const SOURCE_ROOT = join(import.meta.dir);

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'testing') continue;
      files.push(...(await sourceFiles(path)));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test-d.ts') &&
      !entry.name.endsWith('.test-support.ts')
    ) {
      files.push(path);
    }
  }
  return files;
}

describe('every path to the run’s generate passes media admission (COR-716)', () => {
  it('the step loop reaches deps.generate only through callGenerateWithRetry', async () => {
    const callers = new Map<string, number>();
    for (const file of await sourceFiles(SOURCE_ROOT)) {
      const text = await readFile(file, 'utf8');
      const matches = text.match(/deps\.generate\b/g);
      if (matches) callers.set(file.slice(SOURCE_ROOT.length + 1), matches.length);
    }
    // `run-step-media.ts` reads the attached descriptors; `run-step-generation.ts`
    // passes the function to `callGenerateWithRetry` (once per trace branch).
    expect([...callers.keys()].toSorted()).toEqual(['run-step-generation.ts', 'run-step-media.ts']);
    const generation = await readFile(join(SOURCE_ROOT, 'run-step-generation.ts'), 'utf8');
    expect(generation.match(/callGenerateWithRetry\(\s*deps\.generate,/g)).toHaveLength(2);
    expect(generation.match(/admitMutated,/g)).toHaveLength(2);
  });

  it('both onMaximumSteps tails derive resolvedSources before calling the handler', async () => {
    for (const [file, invocation] of [
      ['loop.ts', /await onMaximumSteps\(\{[^}]*resolvedSources: media\.resolvedSources/s],
      ['durable/run-workflow.ts', /await handler\(\{[^}]*resolvedSources: media\.resolvedSources/s],
    ] as const) {
      const text = await readFile(join(SOURCE_ROOT, file), 'utf8');
      expect(text).toMatch(invocation);
      expect(text).toContain('createStepMediaAdmission(');
    }
  });
});
