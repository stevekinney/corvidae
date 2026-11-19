#!/usr/bin/env bun
// Chef dispatch check: overlap ordering for batches. Two batches that change the same files build
// in sequence, never side by side, because the second would be merged onto the first's rewrite and
// need a new evidence run (review corrections, section 5; `land-queue.ts` re-verifies at landing,
// this check keeps the clash from being built at all).
//
// The dispatch input is the run's batch file, a sibling of its note and log:
// `<main checkout>/tmp/chef/<run id>-batch.json`.
//
//   {
//     "batches": [
//       { "id": "workflow-pages", "paths": ["applications/interborough/src/routes/workflows/"],
//         "waitsOn": [], "state": "pending" },
//       { "id": "chat-empty-state", "paths": ["components/chat/src/lib/components/chat/**"],
//         "waitsOn": ["workflow-pages"], "state": "pending" }
//     ],
//     "order": { "started": [], "landed": [] }
//   }
//
// `paths` are files, directories (a trailing slash) or globs (`*`, `**`); a glob claims its
// directory, so the check errs toward ordering. `waitsOn` names batches that must have landed.
// `state` is `pending`, `building` or `landed`.
//
// Usage:
//   bun scripts/chef/dispatch-check.ts check <batch.json> --batch <id> [--json]
//   bun scripts/chef/dispatch-check.ts start <batch.json> --batch <id> [--json]
//   bun scripts/chef/dispatch-check.ts land  <batch.json> --batch <id> [--json]
//
// `check` refuses a batch that starts while a batch it `waitsOn` has not landed, or while any other
// building batch declares overlapping paths and is not waited on. `start` runs `check`, then marks
// the batch `building` and appends it to `order.started`; `land` marks it `landed` and appends it to
// `order.landed`, which records the landing order. Exit codes: 0 allowed, 1 refused, 2 invalid input.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

import { emitResult, parseOptions, requireOption, UsageError } from './process-runner.ts';

export { UsageError };

export type BatchState = 'pending' | 'building' | 'landed';

export interface Batch {
  id: string;
  paths: string[];
  waitsOn: string[];
  state: BatchState;
}

export interface BatchFile {
  batches: Batch[];
  order: { started: string[]; landed: string[] };
}

export interface Refusal {
  batch: string;
  reason: 'waits-on-unlanded' | 'overlaps-building';
  other: string;
  /** The declared paths that overlap, as `<this batch's path> <other batch's path>`. */
  paths: string[];
}

/** A declared path as a directory claim: a subtree below `base`, or exactly the file `base`. */
interface Claim {
  base: string;
  subtree: boolean;
}

function claimOf(path: string): Claim {
  const normalized = path.replace(/^\.\//, '');
  const glob = normalized.search(/[*?[{]/);
  if (glob >= 0)
    return { base: normalized.slice(0, normalized.lastIndexOf('/', glob)), subtree: true };
  if (normalized.endsWith('/')) return { base: normalized.replace(/\/+$/, ''), subtree: true };
  return { base: normalized, subtree: false };
}

function within(inner: string, outer: string): boolean {
  return outer === '' || inner === outer || inner.startsWith(`${outer}/`);
}

export function pathsOverlap(first: string, second: string): boolean {
  const a = claimOf(first);
  const b = claimOf(second);
  if (a.subtree && within(b.base, a.base)) return true;
  if (b.subtree && within(a.base, b.base)) return true;
  return !a.subtree && !b.subtree && a.base === b.base;
}

export function overlappingPaths(first: Batch, second: Batch): string[] {
  return first.paths.flatMap((a) =>
    second.paths.filter((b) => pathsOverlap(a, b)).map((b) => `${a} ${b}`),
  );
}

function find(file: BatchFile, id: string): Batch {
  const batch = file.batches.find((candidate) => candidate.id === id);
  if (batch === undefined) throw new UsageError(`No batch ${id} in the batch file.`);
  return batch;
}

/** Why `id` may not start now; empty when it may. */
export function refusals(file: BatchFile, id: string): Refusal[] {
  const batch = find(file, id);
  const found: Refusal[] = [];
  for (const waited of batch.waitsOn) {
    if (find(file, waited).state !== 'landed')
      found.push({ batch: id, reason: 'waits-on-unlanded', other: waited, paths: [] });
  }
  for (const other of file.batches) {
    if (other.id === id || other.state !== 'building' || batch.waitsOn.includes(other.id)) continue;
    const paths = overlappingPaths(batch, other);
    if (paths.length > 0)
      found.push({ batch: id, reason: 'overlaps-building', other: other.id, paths });
  }
  return found;
}

function parseBatchFile(text: string): BatchFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError('The batch file is not valid JSON.');
  }
  const batches = (parsed as { batches?: unknown } | null)?.batches;
  if (!Array.isArray(batches)) throw new UsageError('The batch file needs a "batches" array.');
  const ids = new Set<string>();
  const checked = batches.map((entry: Partial<Batch> | null): Batch => {
    const strings = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((item) => typeof item === 'string');
    if (typeof entry?.id !== 'string' || entry.id === '')
      throw new UsageError('Every batch needs a string "id".');
    if (ids.has(entry.id)) throw new UsageError(`Batch ${entry.id} is declared twice.`);
    ids.add(entry.id);
    if (!strings(entry.paths) || entry.paths.length === 0)
      throw new UsageError(`Batch ${entry.id} declares no "paths".`);
    if (!strings(entry.waitsOn)) throw new UsageError(`Batch ${entry.id} needs a "waitsOn" array.`);
    if (entry.state !== 'pending' && entry.state !== 'building' && entry.state !== 'landed')
      throw new UsageError(`Batch ${entry.id} has no valid "state".`);
    return { id: entry.id, paths: entry.paths, waitsOn: entry.waitsOn, state: entry.state };
  });
  for (const batch of checked)
    for (const waited of batch.waitsOn)
      if (!ids.has(waited)) throw new UsageError(`Batch ${batch.id} waits on unknown ${waited}.`);
  const order = (parsed as { order?: Partial<BatchFile['order']> }).order ?? {};
  return {
    batches: checked,
    order: { started: order.started ?? [], landed: order.landed ?? [] },
  };
}

export function formatRefusals(found: Refusal[]): string {
  return found
    .map((refusal) =>
      refusal.reason === 'waits-on-unlanded'
        ? `${refusal.batch}: waits on ${refusal.other}, which has not landed`
        : `${refusal.batch}: overlaps ${refusal.other}, which is building and not waited on\n${refusal.paths.map((path) => `  ${path}`).join('\n')}`,
    )
    .join('\n');
}

export interface DispatchDependencies {
  read: (path: string) => string;
  write: (path: string, text: string) => void;
}

const defaults: DispatchDependencies = {
  read: (path) => readFileSync(path, 'utf8'),
  write: (path, text) => {
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, text);
    renameSync(temporary, path);
  },
};

export function run(
  argv: string[],
  dependencies: DispatchDependencies = defaults,
): { code: number; output: string } {
  const parsed = parseOptions(argv, { values: ['batch'], flags: ['json'] });
  const [command, path, ...extra] = parsed.positionals;
  if (extra.length > 0 || path === undefined || !['check', 'start', 'land'].includes(command ?? ''))
    throw new UsageError('Usage: dispatch-check.ts <check|start|land> <batch.json> --batch <id>');
  const id = requireOption(parsed, 'batch');
  const file = parseBatchFile(dependencies.read(path));
  const batch = find(file, id);
  const json = parsed.flags.has('json');
  if (command === 'land') {
    if (batch.state !== 'building')
      throw new UsageError(`Batch ${id} is ${batch.state}, not building.`);
    batch.state = 'landed';
    file.order.landed.push(id);
    dependencies.write(path, `${JSON.stringify(file, null, 2)}\n`);
    return {
      code: 0,
      output: json ? JSON.stringify({ allowed: true, landed: id }) : `${id} landed`,
    };
  }
  if (batch.state !== 'pending')
    throw new UsageError(`Batch ${id} is ${batch.state}, not pending.`);
  const found = refusals(file, id);
  if (found.length > 0)
    return {
      code: 1,
      output: json ? JSON.stringify({ allowed: false, refusals: found }) : formatRefusals(found),
    };
  if (command === 'start') {
    batch.state = 'building';
    file.order.started.push(id);
    dependencies.write(path, `${JSON.stringify(file, null, 2)}\n`);
  }
  return {
    code: 0,
    output: json
      ? JSON.stringify({ allowed: true, batch: id })
      : `${id} may ${command === 'start' ? 'start (now building)' : 'start'}`,
  };
}

if (import.meta.main) {
  try {
    const { code, output } = run(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
