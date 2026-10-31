/**
 * A control that sends a write carries `data-changes` (COR-1839), so the shell can dim it and hold
 * its activation while the server is unreachable (`changing-actions.ts`). The request is refused
 * anyway (`../../lib/write-guard.ts`), so a miss is a control that looks usable and fails when
 * pressed. This reads every non-test `.svelte` file under `src` and fails for an element or
 * component whose event handler reaches a write and that is not marked, so a new write control
 * cannot arrive unmarked.
 *
 * A handler reaches a write when it, or a function of the same file it names, calls `.mutate` or
 * `.mutateAsync` on a mutation, or calls an exported function of `src` that sends one (a
 * `callBureau` of an operation that is not a read, or a Weft client write). What is marked:
 *
 * - `Button` and native elements: `data-changes`, unless the button is `type="submit"`, which the
 *   shell already holds.
 * - `ConfirmDialog`, and a component that wraps one: its confirm button is Cinder's, so the control that opens the dialog is the
 *   marked one (`bind:open={name}` is read, and whatever sets `name = true` is a write handler): the
 *   dialog never opens while the server is unreachable, and one that was already open sends
 *   nothing, because the request is refused.
 * - Any other component that is handed a write handler: `data-changes` somewhere in that
 *   component's file or the files it imports, because it owns the buttons.
 * - `ALWAYS_CHANGING`: components whose callback is a write wherever it is used, which the callers'
 *   handlers hide from this reading.
 *
 * What it cannot see, and the runtime refusal still covers: a handler passed through a prop and
 * called by a component outside `src`, a write reached through a function it does not read as one
 * (a dynamic import, a store method), and a form whose `onsubmit` writes with no submit button.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parse } from 'svelte/compiler';

import { isReadOperation } from '../../lib/write-guard.ts';

const SOURCE_ROOT = join(import.meta.dir, '..', '..');

/** Components whose callback always writes, whoever hands it one. Paths are relative to `src`. */
const ALWAYS_CHANGING = [
  'lib/decision/approval-decision.svelte',
  // Forget opens a confirmation through `changes?.askToForget`, an object's method this reading
  // cannot follow; Correct saves in place, and the governance buttons open the page's dialogs or
  // ask for a hold through `governance?.changeHold`, which it cannot follow either.
  'routes/agents/memory-detail.svelte',
];

const TEST_FILE = /\.test(-[a-z]+)?\.(ts|svelte)$/;
const WEFT_WRITES =
  /\bclient\.(start|startOrSignal|signal|cancel|suspend|resume|fork|update|schedule|updateSchedule|pauseSchedule|resumeSchedule|cancelSchedule|submitReview|addTags|removeTags|timeout|purge|replayTo|presign)\(/;
const MARKS = ['data-changes', 'type="submit"'];

/**
 * Mutations that only read: they are mutations because they run on a press, not because they
 * change anything, so their controls stay as they are. The Bureau's refusal classifies the
 * operation itself (`READ_OPERATIONS`), so a read that is wrongly listed here still works offline
 * only until someone presses it.
 */
const READING_MUTATIONS = new Set([
  'getMutation',
  'scanMutation',
  'previewMutation',
  // The audit log's Export reads every page of the trail, then saves a file.
  'exportMutation',
]);

const MUTATE_CALL = /\b(\w+)(?:\.\w+)?\.mutate(?:Async)?\b/g;

/** Whether `text` calls `.mutate` on a mutation that changes something. */
function callsWritingMutation(text: string): boolean {
  return [...text.matchAll(MUTATE_CALL)].some((call) => !READING_MUTATIONS.has(call[1]!));
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (!TEST_FILE.test(entry.name) && /\.(ts|svelte)$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** The exported functions of `src` that send a write: by name, from their own text. */
function exportedWriteFunctions(): Set<string> {
  const names = new Set<string>();
  for (const path of sourceFiles(SOURCE_ROOT).filter((file) => file.endsWith('.ts'))) {
    if (path.includes('/host/') || path.endsWith('.test-support.ts')) continue;
    const text = readFileSync(path, 'utf8');
    const declarations = [...text.matchAll(/^export (?:async )?function (\w+)/gm)];
    for (const [index, declaration] of declarations.entries()) {
      const end = declarations[index + 1]?.index ?? text.length;
      const body = text.slice(declaration.index, end);
      const operations = [...body.matchAll(/callBureau\(\s*(?:'([\w.]+)'|(\w+))/g)];
      const writesBureau = operations.some(
        (call) => call[2] !== undefined || !isReadOperation(call[1] ?? ''),
      );
      if (writesBureau || WEFT_WRITES.test(body)) names.add(declaration[1]!);
    }
  }
  return names;
}

interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly name?: string;
  readonly attributes?: readonly Attribute[];
  readonly [key: string]: unknown;
}
interface Attribute extends Node {
  readonly value?: unknown;
}

function walk(node: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
  } else if (typeof node === 'object' && node !== null) {
    const typed = node as Node;
    if (typeof typed.type === 'string') visit(typed);
    for (const [key, child] of Object.entries(node)) {
      if (key !== 'metadata' && key !== 'parent') walk(child, visit);
    }
  }
}

const identifiersOf = (text: string): string[] => text.match(/[A-Za-z_$][\w$]*/g) ?? [];

/** The text of a component's own top-level functions, by name. */
function localFunctions(source: string, script: Node | null | undefined): Map<string, string> {
  const functions = new Map<string, string>();
  const body = (script?.['content'] as { body?: Node[] } | undefined)?.body ?? [];
  for (const statement of body) {
    if (statement.type === 'FunctionDeclaration') {
      functions.set((statement['id'] as Node).name!, source.slice(statement.start, statement.end));
    } else if (statement.type === 'VariableDeclaration') {
      for (const declarator of statement['declarations'] as Node[]) {
        const init = declarator['init'] as Node | null;
        if (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression') {
          functions.set(
            (declarator['id'] as Node).name!,
            source.slice(declarator.start, declarator.end),
          );
        }
      }
    }
  }
  return functions;
}

/** The names of a component's own functions that reach a write, to a fixed point. */
function localWriteFunctions(
  source: string,
  script: Node | null | undefined,
  external: ReadonlySet<string>,
): Set<string> {
  const functions = localFunctions(source, script);
  const writes = new Set<string>();
  const reachesWrite = (text: string): boolean =>
    callsWritingMutation(text) ||
    WEFT_WRITES.test(text) ||
    identifiersOf(text).some((word) => external.has(word) || writes.has(word));
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, text] of functions) {
      if (!writes.has(name) && reachesWrite(text)) {
        writes.add(name);
        changed = true;
      }
    }
  }
  return writes;
}

/** The `.svelte` files a file imports by a relative path, resolved. */
function importedComponents(source: string, file: string): Map<string, string> {
  const imports = new Map<string, string>();
  for (const match of source.matchAll(
    /import\s+(\w+)\s*(?:,\s*\{[^}]*\})?\s*from\s+'(\.[^']+\.svelte)'/g,
  )) {
    imports.set(match[1]!, resolve(dirname(file), match[2]!));
  }
  // A component loaded on demand is rendered under the PascalCase of its file name.
  for (const match of source.matchAll(/import\('(\.[^']+?([\w-]+)\.svelte)'\)/g)) {
    const pascal = match[2]!.replaceAll(/(^|-)(\w)/g, (_, __, letter: string) =>
      letter.toUpperCase(),
    );
    imports.set(pascal, resolve(dirname(file), match[1]!));
  }
  return imports;
}

function carriesMark(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  const text = readFileSync(file, 'utf8');
  if (MARKS.some((mark) => text.includes(mark))) return true;
  return [...importedComponents(text, file).values()].some((child) => carriesMark(child, seen));
}

export interface Unmarked {
  readonly file: string;
  readonly line: number;
  readonly element: string;
  readonly handler: string;
}

/** The elements and components of one `.svelte` file that hand a write to a handler without a mark. */
export function findUnmarkedChangingControls(
  file: string,
  source: string,
  external: ReadonlySet<string>,
): Unmarked[] {
  const root = parse(source, { modern: true }) as unknown as {
    fragment: Node;
    instance: Node | null;
  };
  const writes = localWriteFunctions(source, root.instance, external);
  const components = importedComponents(source, file);
  const unmarked: Unmarked[] = [];

  // The state a ConfirmDialog with a write behind it is open on, and what sets it.
  const opening = new Set<string>();
  const isDialog = (name: string): boolean => {
    const target = components.get(name);
    return (
      name === 'ConfirmDialog' ||
      (target !== undefined && readFileSync(target, 'utf8').includes('<ConfirmDialog'))
    );
  };
  walk(root.fragment, (node) => {
    if (node.type !== 'Component' || !isDialog(node.name!)) return;
    const confirm = node.attributes?.find((entry) => entry.name === 'onConfirm');
    const confirmText = confirm === undefined ? '' : source.slice(confirm.start, confirm.end);
    const confirmsWrite =
      callsWritingMutation(confirmText) ||
      identifiersOf(confirmText).some((word) => external.has(word) || writes.has(word));
    const open = node.attributes?.find((entry) => entry.name === 'open');
    const variable = /\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(
      open === undefined ? '' : source.slice(open.start, open.end),
    )?.[1];
    if (confirmsWrite && variable !== undefined) opening.add(variable);
  });
  const opens = (text: string): boolean =>
    [...opening].some((variable) => new RegExp(`\\b${variable}\\s*=\\s*true`).test(text));
  const openingFunctions = new Set(
    [...localFunctions(source, root.instance)]
      .filter(([, text]) => opens(text))
      .map(([name]) => name),
  );
  const startsWrite = (text: string): boolean =>
    callsWritingMutation(text) ||
    opens(text) ||
    identifiersOf(text).some(
      (word) => external.has(word) || writes.has(word) || openingFunctions.has(word),
    );

  walk(root.fragment, (node) => {
    if (node.attributes === undefined) return;
    const isComponent = node.type === 'Component';
    if (!isComponent && node.type !== 'RegularElement') return;
    // A component that types no `data-*` props takes the mark through a spread: `{...{ 'data-changes': true }}`.
    const attribute = (name: string) =>
      node.attributes!.find(
        (entry) =>
          entry.name === name ||
          (entry.type === 'SpreadAttribute' && source.slice(entry.start, entry.end).includes(name)),
      );
    const handler = node.attributes.find((entry) => {
      const value = entry.value as Node | undefined;
      if (entry.type !== 'Attribute' || !/^on[a-z]/i.test(entry.name ?? '')) return false;
      if (value?.type !== 'ExpressionTag') return false;
      return startsWrite(source.slice(value.start, value.end));
    });
    if (handler === undefined) return;
    const name = node.name!;
    const typeValue = attribute('type')?.value as Node[] | undefined;
    const isSubmit =
      Array.isArray(typeValue) && (typeValue[0] as { data?: string })?.data === 'submit';
    let marked: boolean;
    if (!isComponent || name === 'Button') {
      marked = attribute('data-changes') !== undefined || isSubmit || name === 'form';
    } else if (isDialog(name)) {
      return;
    } else {
      const target = components.get(name);
      marked =
        attribute('data-changes') !== undefined || (target !== undefined && carriesMark(target));
    }
    if (!marked) {
      unmarked.push({
        file: relative(SOURCE_ROOT, file),
        line: source.slice(0, node.start).split('\n').length,
        element: name,
        handler: handler.name ?? '',
      });
    }
  });
  return unmarked;
}

describe('changing controls', () => {
  const external = exportedWriteFunctions();
  const svelteFiles = sourceFiles(SOURCE_ROOT).filter((file) => file.endsWith('.svelte'));

  test('finds the writes of src to look for', () => {
    for (const name of ['cancelTask', 'respondToTask', 'resolveBureauReview']) {
      expect(external.has(name)).toBe(true);
    }
    expect(external.has('listContexts')).toBe(false);
  });

  test('every control that sends a write is marked data-changes', () => {
    const unmarked = svelteFiles.flatMap((file) =>
      findUnmarkedChangingControls(file, readFileSync(file, 'utf8'), external),
    );
    expect(unmarked.map((e) => `${e.file}:${e.line} ${e.element} ${e.handler}`)).toEqual([]);
  });

  test('the components whose callback always writes are marked', () => {
    for (const path of ALWAYS_CHANGING) {
      expect(readFileSync(join(SOURCE_ROOT, path), 'utf8')).toContain('data-changes');
    }
  });

  test('reads a handler through a function of the same file, and a component that owns the button', () => {
    const source = `<script lang="ts">
  import { cancelTask } from '../lib/bureau-tasks.ts';
  const send = createMutation(() => ({}));
  function go() { send.mutate(1); }
  async function stop() { await cancelTask('x'); }
  function harmless() { return 1; }
</script>
<Button onclick={go}>Go</Button>
<Button data-changes onclick={go}>Marked</Button>
<Button type="submit" onclick={go}>Submit</Button>
<button onclick={() => stop()}>Stop</button>
<Button onclick={harmless}>Fine</Button>
<ConfirmDialog bind:open={asking} onConfirm={go} />
<Button onclick={() => (asking = true)}>Opens a write</Button>
<Button data-changes onclick={() => (asking = true)}>Marked opener</Button>
<ConfirmDialog bind:open={sure} onConfirm={harmless} />
<Button onclick={() => (sure = true)}>Opens a harmless one</Button>`;
    const found = findUnmarkedChangingControls(
      join(SOURCE_ROOT, 'app/x.svelte'),
      source,
      new Set(['cancelTask']),
    ).map((entry) => `${entry.element}@${entry.line}`);
    expect(found).toEqual(['Button@8', 'button@11', 'Button@14']);
  });
});
