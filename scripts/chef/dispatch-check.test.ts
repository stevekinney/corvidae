import { describe, expect, test } from 'bun:test';

import {
  pathsOverlap,
  refusals,
  run,
  UsageError,
  type Batch,
  type BatchFile,
  type DispatchDependencies,
} from './dispatch-check.ts';

const batch = (
  id: string,
  paths: string[],
  state: Batch['state'],
  waitsOn: string[] = [],
): Batch => ({
  id,
  paths,
  waitsOn,
  state,
});

function store(batches: Batch[]): { dependencies: DispatchDependencies; saved: () => BatchFile } {
  let text = JSON.stringify({ batches });
  return {
    dependencies: {
      read: () => text,
      write: (_, next) => {
        text = next;
      },
    },
    saved: () => JSON.parse(text) as BatchFile,
  };
}

const workflowPages = batch(
  'workflow-pages',
  [
    'applications/interborough/src/routes/workflows/',
    'applications/interborough/src/lib/run-rows.ts',
  ],
  'building',
);
const chat = batch(
  'chat-empty-state',
  ['applications/interborough/src/lib/run-rows.ts'],
  'pending',
);

describe('dispatch check', () => {
  test('refuses a batch whose paths overlap a building batch it does not wait on', () => {
    const { dependencies } = store([workflowPages, chat]);
    const result = run(['check', 'batches.json', '--batch', 'chat-empty-state'], dependencies);
    expect(result.code).toBe(1);
    expect(result.output).toContain('overlaps workflow-pages');
    expect(result.output).toContain('run-rows.ts');
  });

  test('start refuses the same case and leaves the file untouched', () => {
    const { dependencies, saved } = store([workflowPages, chat]);
    expect(run(['start', 'b.json', '--batch', 'chat-empty-state'], dependencies).code).toBe(1);
    expect(saved().batches[1]?.state).toBe('pending');
  });

  test('a batch with disjoint paths starts beside a building one', () => {
    const { dependencies, saved } = store([
      workflowPages,
      batch('plugins', ['applications/interborough/src/routes/plugins/'], 'pending'),
    ]);
    expect(run(['start', 'b.json', '--batch', 'plugins'], dependencies).code).toBe(0);
    expect(saved().batches[1]?.state).toBe('building');
    expect(saved().order.started).toEqual(['plugins']);
  });

  test('waiting on the overlapping batch allows the start only once it has landed', () => {
    const waiting = batch('chat-empty-state', chat.paths, 'pending', ['workflow-pages']);
    const building = refusals(
      { batches: [workflowPages, waiting], order: { started: [], landed: [] } },
      'chat-empty-state',
    );
    expect(building.map((refusal) => refusal.reason)).toEqual(['waits-on-unlanded']);
    const landed = { ...workflowPages, state: 'landed' as const };
    expect(
      refusals(
        { batches: [landed, waiting], order: { started: [], landed: [] } },
        'chat-empty-state',
      ),
    ).toEqual([]);
  });

  test('land records the landing order', () => {
    const { dependencies, saved } = store([
      workflowPages,
      batch('plugins', ['applications/interborough/src/routes/plugins/'], 'building'),
    ]);
    run(['land', 'b.json', '--batch', 'plugins'], dependencies);
    run(['land', 'b.json', '--batch', 'workflow-pages'], dependencies);
    expect(saved().order.landed).toEqual(['plugins', 'workflow-pages']);
    expect(saved().batches.map((entry) => entry.state)).toEqual(['landed', 'landed']);
  });

  test('path overlap: files, directories and globs', () => {
    expect(pathsOverlap('a/b.ts', 'a/b.ts')).toBe(true);
    expect(pathsOverlap('a/b.ts', 'a/b.test.ts')).toBe(false);
    expect(pathsOverlap('a/b/', 'a/b/c/d.ts')).toBe(true);
    expect(pathsOverlap('a/bc/', 'a/b/c.ts')).toBe(false);
    expect(pathsOverlap('a/**/*.ts', 'a/x/y.ts')).toBe(true);
    expect(pathsOverlap('a/*.ts', 'b/x.ts')).toBe(false);
  });

  test('invalid input is refused as a usage error', () => {
    const unknown = store([batch('x', ['a'], 'pending', ['missing'])]);
    expect(() => run(['check', 'b.json', '--batch', 'x'], unknown.dependencies)).toThrow(
      UsageError,
    );
    const none = store([batch('x', [], 'pending')]);
    expect(() => run(['check', 'b.json', '--batch', 'x'], none.dependencies)).toThrow(UsageError);
    const started = store([batch('x', ['a'], 'building')]);
    expect(() => run(['start', 'b.json', '--batch', 'x'], started.dependencies)).toThrow(
      UsageError,
    );
    expect(() => run(['check', 'b.json'], started.dependencies)).toThrow(UsageError);
  });
});
