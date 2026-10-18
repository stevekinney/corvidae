/**
 * COR-716 — the admission invariant is only as strong as the set of paths to the
 * run's `generate`. This guard pins that set: the step loop reaches
 * `deps.generate` through `callGenerateWithRetry` alone (where the binding
 * admission and the mutated-retry derivation live), and the two
 * `onMaximumSteps` tails derive `resolvedSources` before handing the handler
 * its context. A new path to `generate` must either go through one of these or
 * be added here with its own derivation. Counts are exact, so a new reference
 * in an already-allowed file fails too, and a destructured alias
 * (`const { generate } = deps`) is caught as well.
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

/** Every reference to the run's generate function in one source file. */
function referencesToDepsGenerate(text: string): {
  readonly references: number;
  readonly invocations: number;
  readonly destructured: number;
} {
  return {
    references: text.match(/\bdeps\.generate\b/g)?.length ?? 0,
    // `deps.generate(` is a direct call; the sanctioned uses pass or read it.
    invocations: text.match(/\bdeps\.generate\s*\(/g)?.length ?? 0,
    // `const { generate } = deps`, `{ generate: g } = deps`, and `({ generate }: StepDeps)`.
    destructured:
      (text.match(/\{[^}]*\bgenerate\b[^}]*\}\s*=\s*(?:deps|input\.deps)\b/g)?.length ?? 0) +
      (text.match(/\{[^}]*\bgenerate\b[^}]*\}\s*:\s*StepDeps\b/g)?.length ?? 0),
  };
}

describe('every path to the run’s generate passes media admission (COR-716)', () => {
  it('the step loop references deps.generate exactly where admission does, and never calls it directly', async () => {
    const seen = new Map<string, ReturnType<typeof referencesToDepsGenerate>>();
    for (const file of await sourceFiles(SOURCE_ROOT)) {
      const text = await readFile(file, 'utf8');
      const counts = referencesToDepsGenerate(text);
      if (counts.references > 0 || counts.destructured > 0) {
        seen.set(file.slice(SOURCE_ROOT.length + 1), counts);
      }
    }
    // `run-step-media.ts` reads the attached descriptors once;
    // `run-step-generation.ts` passes the function to `callGenerateWithRetry`
    // once per trace branch. Nothing calls it, and nothing aliases it.
    expect(
      Object.fromEntries([...seen.entries()].toSorted(([a], [b]) => a.localeCompare(b))),
    ).toEqual({
      'run-step-generation.ts': { references: 2, invocations: 0, destructured: 0 },
      'run-step-media.ts': { references: 1, invocations: 0, destructured: 0 },
    });
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
      expect(text.match(/createStepMediaAdmission\(/g)).toHaveLength(1);
      expect(text).toMatch(/\}\)\.derive\(conversation\)/);
    }
  });
});
