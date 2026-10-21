/**
 * The workflow types `createRunEngine` registers are the types a host that schedules by type
 * reserves, and the module that lists them is safe for a browser to read.
 */
import { Engine, MemoryStorage, workflow } from '@lostgradient/weft';
import { describe, expect, it, spyOn } from 'bun:test';

import { createRunEngine } from './create-run-engine';
import { RUN_ENGINE_WORKFLOW_TYPE, RUN_ENGINE_WORKFLOW_TYPES } from './run-engine-workflow-types';

const named = (name: string) =>
  workflow({ name }).execute(async function* (ctx) {
    return yield* ctx.run(() => Promise.resolve('idle'));
  });

/** The types `createRunEngine` handed to `Engine.create`, which is the engine's whole registry. */
async function registeredTypes(withGoal: boolean): Promise<string[]> {
  const create = spyOn(Engine, 'create');
  try {
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: named('agentRun'),
      ...(withGoal ? { goalWorkflow: named('goalRun') } : {}),
      recover: false,
    });
    engine[Symbol.dispose]();
    const registry = create.mock.calls[0]?.[0]?.workflows;
    return Object.keys(registry ?? {}).toSorted();
  } finally {
    create.mockRestore();
  }
}

/** One way a module can reach another, and the pattern that finds it. */
const IMPORT_FORMS: readonly { readonly form: string; readonly pattern: RegExp }[] = [
  // `import x from './x'`, `import './x'`, and `import type`.
  { form: 'import statement', pattern: /^\s*import\s/m },
  // `export * from './x'` and `export { x } from './x'`, which load the module as an import does.
  { form: "from '", pattern: /\bfrom\s*'/ },
  { form: 'from "', pattern: /\bfrom\s*"/ },
  { form: 'import(', pattern: /\bimport\s*\(/ },
  { form: 'require(', pattern: /\brequire\s*\(/ },
];

/** The forms of import `source` contains, which is none for a module a browser can read alone. */
function importFormsIn(source: string): string[] {
  return IMPORT_FORMS.filter(({ pattern }) => pattern.test(source)).map(({ form }) => form);
}

describe('the types a Bureau’s run engine registers', () => {
  it('are the agent run, the heartbeat tick, and the goal', () => {
    expect([...RUN_ENGINE_WORKFLOW_TYPES].toSorted()).toEqual([
      'agentRun',
      'durableHeartbeatTick',
      'goalRun',
    ]);
    expect(RUN_ENGINE_WORKFLOW_TYPE.agentRun).toBe('agentRun');
  });

  it('are exactly the types the engine registers when it runs durable goals', async () => {
    expect(await registeredTypes(true)).toEqual([...RUN_ENGINE_WORKFLOW_TYPES].toSorted());
  });

  it('leave out the goal only when the host runs none', async () => {
    expect(await registeredTypes(false)).toEqual(['agentRun', 'durableHeartbeatTick']);
  });

  it('are listed by a module that imports nothing, so a browser can read them alone', async () => {
    const source = await Bun.file(
      new URL('./run-engine-workflow-types.ts', import.meta.url),
    ).text();
    expect(importFormsIn(source)).toEqual([]);
  });
});

describe('the check that a module imports nothing', () => {
  it.each([
    [
      'an import statement',
      "import { a } from './a';\nexport const b = 1;",
      ['import statement', "from '"],
    ],
    ['a side-effect import', "import './a';", ['import statement']],
    ['a re-export from a single-quoted path', "export { a } from './a';", ["from '"]],
    ['a re-export from a double-quoted path', 'export * from "./a";', ['from "']],
    ['a dynamic import', "export const load = () => import('./a');", ['import(']],
    ['a require call', "const a = require('./a');", ['require(']],
  ])('refuses %s', (_name, source, forms) => {
    expect(importFormsIn(source)).toEqual(forms);
  });

  it('passes a module that only declares values', () => {
    expect(importFormsIn("export const A = { b: 'from here' } as const;\n")).toEqual([]);
  });
});
