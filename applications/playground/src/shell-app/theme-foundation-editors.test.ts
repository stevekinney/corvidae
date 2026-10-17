/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { flushSync, mount, tick, unmount } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

import { cinderThemeBase } from './theme-builder-base.ts';
import { catalogueRowByPath, catalogueRows } from './theme-builder-catalogue.ts';
import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import type { JsonObject } from './theme-draft-types.ts';
import { createEnvelope } from './theme-envelope.ts';
import {
  ENVIRONMENT_DEPENDENT_NOTICE,
  environmentDependentFamilies,
} from './theme-font-availability.ts';
import FoundationEditor from './theme-foundation-editor.svelte';
import {
  blankFields,
  fieldsFromValue,
  FOUNDATION_EDITOR_TYPES,
  foundationKindOf,
  parseNumberText,
  valueFromFields,
  type FoundationFields,
} from './theme-foundation-values.ts';
import { memoEvaluator, warmedTests } from './theme-remediation-test-support.ts';
import { literalValueOf } from './theme-token-edit.ts';
import { editorForToken } from './theme-token-editors.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

setupHappyDom();

// A content-keyed evaluator: a state the runtime has evaluated once is answered from memory.
const evaluator = memoEvaluator;
// Validate the shipped corpus once, outside any test's time budget; later evaluations reuse it.
const baseline = createEnvelope('warmup', 'Warm-up', cinderThemeBase());
await evaluator.evaluate(baseline, 0, 'light/default');

let mounted: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

// The tests that edit and reset many tokens evaluate a new state per commit. They are warmed
// at module scope (the end of this file), so Bun's 5 s budget never covers a cold evaluation.
const { group, scenario, warmScenarios } = warmedTests({
  before() {
    target = document.createElement('div');
    document.body.append(target);
  },
  after() {
    if (mounted !== null) void unmount(mounted);
    mounted = null;
    target.remove();
  },
});

beforeEach(() => {
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(() => {
  if (mounted !== null) void unmount(mounted);
  mounted = null;
  target.remove();
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
  await tick();
}

async function open(path: string, context?: { colorMode: 'light' | 'dark'; motion: string }) {
  const workbench = new ThemeWorkbenchState();
  const controller = new ThemeBuilderController({ workbench, evaluator, persistence: null });
  await controller.start();
  if (context !== undefined) {
    workbench.setContext(context as Parameters<typeof workbench.setContext>[0]);
    await settle();
  }
  const row = catalogueRowByPath(path)!;
  mounted = mount(FoundationEditor, { target, props: { controller, workbench, row } });
  await settle();
  return { controller, workbench, row };
}

const input = (suffix: string) => target.querySelector<HTMLInputElement>(`input[id$="${suffix}"]`)!;
const button = (label: string) =>
  [...target.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )!;

async function typeInto(element: HTMLInputElement, text: string): Promise<void> {
  element.value = text;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
}

/** The Apply inside the revision-bound impact list, not the editor's own Apply. */
const impactApply = () =>
  [...target.querySelectorAll('[data-testid="impact-list"] button')].find(
    (candidate) => candidate.textContent?.trim() === 'Apply',
  ) as HTMLButtonElement | undefined;

async function applyImpact(): Promise<void> {
  impactApply()!.click();
  await settle();
}

async function click(label: string): Promise<void> {
  button(label).click();
  await settle();
}

const css = (controller: ThemeBuilderController, path: string) =>
  controller.draftValues.get(catalogueRowByPath(path)!.cssProperty);
const shared = (controller: ThemeBuilderController) => controller.draft!.envelope.overrides.shared;
const entries = (controller: ThemeBuilderController) => controller.history!.entries.length;

describe('which editor a token gets', () => {
  const scalar = catalogueRows.filter((row) => foundationKindOf(row.type) !== null);

  test('every non-color scalar catalogue entry maps to the foundation editor', () => {
    expect(scalar.length).toBeGreaterThan(100);
    for (const type of FOUNDATION_EDITOR_TYPES) {
      expect(scalar.some((row) => row.type === type)).toBe(true);
    }
    for (const row of scalar) expect(editorForToken(row)).toBe(FoundationEditor);
  });

  test('colors and composites keep their own editors', () => {
    const color = catalogueRows.find((row) => row.type === 'color')!;
    expect(editorForToken(color)).not.toBe(FoundationEditor);
  });
});

describe('the round trip', () => {
  const envelope = createEnvelope('round-trip', 'Round trip', cinderThemeBase());
  const context = { colorMode: 'light', motion: 'default' } as const;
  const portable = catalogueRows.filter(
    (row) => foundationKindOf(row.type) !== null && row.edit !== 'css-only',
  );

  test.each(portable.map((row) => [row.path, row] as const))(
    '%s survives fields and back with no coercion or unit loss',
    (_path, row) => {
      const literal = literalValueOf(envelope, context, row.path);
      expect(literal).not.toBeUndefined();
      const kind = foundationKindOf(row.type)!;
      const fields = fieldsFromValue(kind, literal!);
      expect(fields).not.toBeNull();
      const built = valueFromFields(row, fields!);
      expect(built).toEqual({ ok: true, value: literal! });
      expect(JSON.stringify(built.ok ? built.value : null)).toBe(JSON.stringify(literal));
    },
  );

  test('the table covers every scalar entry that has a portable value', () => {
    expect(portable.length).toBeGreaterThan(100);
    expect(new Set(portable.map((row) => row.type))).toEqual(new Set(FOUNDATION_EDITOR_TYPES));
  });

  test('a font stack keeps its shape and order, a weight its name, a dimension its unit', () => {
    const stack = catalogueRowByPath('font.sans')!;
    expect(
      valueFromFields(stack, { kind: 'fontFamily', families: ['Inter'], shape: 'string' }),
    ).toEqual({
      ok: true,
      value: 'Inter',
    });
    expect(
      valueFromFields(stack, {
        kind: 'fontFamily',
        families: ['b', 'a', 'sans-serif'],
        shape: 'array',
      }),
    ).toEqual({ ok: true, value: ['b', 'a', 'sans-serif'] });
    expect(
      valueFromFields(stack, { kind: 'fontFamily', families: ['Inter'], shape: 'array' }),
    ).toEqual({
      ok: true,
      value: ['Inter'],
    });
    const weight = catalogueRowByPath('font.bold')!;
    expect(valueFromFields(weight, { kind: 'fontWeight', amount: 'bold' })).toEqual({
      ok: true,
      value: 'bold',
    });
    expect(valueFromFields(weight, { kind: 'fontWeight', amount: '650' })).toEqual({
      ok: true,
      value: 650,
    });
    const space = catalogueRowByPath('space.2')!;
    expect(valueFromFields(space, { kind: 'dimension', amount: '12', unit: 'px' })).toEqual({
      ok: true,
      value: { value: 12, unit: 'px' },
    });
  });
});

describe('validation', () => {
  const check = (path: string, fields: FoundationFields) =>
    valueFromFields(catalogueRowByPath(path)!, fields);

  test('number text is strict: no hex, separators, Infinity, or empty input', () => {
    for (const bad of ['', ' ', '-', '.', '1e', 'abc', 'Infinity', '0x10', '1,5', '1 2', 'NaN']) {
      expect(parseNumberText(bad)).toBeUndefined();
    }
    expect(parseNumberText('1.')).toBe(1);
    expect(parseNumberText('-0.5')).toBe(-0.5);
    expect(parseNumberText('1e3')).toBe(1000);
  });

  test('opacity is finite 0 to 1 and labeled as Cinder’s limit', () => {
    const at = (amount: string) => check('opacity.disabled', { kind: 'number', amount });
    expect(at('0')).toEqual({ ok: true, value: 0 });
    expect(at('1')).toEqual({ ok: true, value: 1 });
    expect(at('1.01')).toMatchObject({ ok: false });
    expect(at('-0.1')).toMatchObject({ ok: false });
    const refused = at('2');
    expect(!refused.ok && refused.errors['amount']).toContain('Cinder limit');
  });

  test('z-index is a signed 32-bit integer', () => {
    const at = (amount: string) => check('z.modal', { kind: 'number', amount });
    expect(at('-2147483648')).toMatchObject({ ok: true });
    expect(at('2147483647')).toMatchObject({ ok: true });
    expect(at('2147483648')).toMatchObject({ ok: false });
    expect(at('1.5')).toMatchObject({ ok: false });
  });

  test('font weight accepts 1 to 1000 and DTCG names, and nothing else', () => {
    const at = (amount: string) => check('font.bold', { kind: 'fontWeight', amount });
    expect(at('1')).toMatchObject({ ok: true });
    expect(at('1000')).toMatchObject({ ok: true });
    expect(at('semi-bold')).toEqual({ ok: true, value: 'semi-bold' });
    expect(at('0')).toMatchObject({ ok: false });
    expect(at('1001')).toMatchObject({ ok: false });
    expect(at('heavier')).toMatchObject({ ok: false });
    expect(at('BOLD')).toMatchObject({ ok: false });
  });

  test('duration is finite and nonnegative with ms or s units', () => {
    const at = (amount: string, unit = 'ms') =>
      check('motion.fast', { kind: 'duration', amount, unit });
    expect(at('0')).toMatchObject({ ok: true });
    expect(at('1.5', 's')).toEqual({ ok: true, value: { value: 1.5, unit: 's' } });
    expect(at('-1')).toMatchObject({ ok: false });
    expect(at('5', 'px')).toMatchObject({ ok: false });
  });

  test('dimension limits follow the token’s own profile, not the dimension type', () => {
    const at = (path: string, amount: string) =>
      check(path, { kind: 'dimension', amount, unit: 'px' });
    expect(at('space.2', '-1')).toMatchObject({ ok: false });
    expect(at('font.size.base', '0')).toMatchObject({ ok: false });
    expect(at('tracking.normal', '-0.5')).toMatchObject({ ok: true });
    expect(at('ring.offset', '-2')).toMatchObject({ ok: true });
  });

  test('cubic-bezier holds x1 and x2 to 0 to 1 and leaves y free', () => {
    const at = (...points: [string, string, string, string]) =>
      check('ease.standard', { kind: 'cubicBezier', points });
    expect(at('0', '-0.5', '1', '1.5')).toEqual({ ok: true, value: [0, -0.5, 1, 1.5] });
    const bad = at('1.2', '0', '-0.1', '0');
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && Object.keys(bad.errors).toSorted()).toEqual(['x1', 'x2']);
    expect(at('0', 'x', '1', '1')).toMatchObject({ ok: false });
  });

  test('a font stack needs at least one clean family', () => {
    const at = (families: string[]) =>
      check('font.sans', { kind: 'fontFamily', families, shape: 'array' });
    expect(at([])).toMatchObject({ ok: false });
    expect(at(['a', ''])).toMatchObject({ ok: false });
    expect(at(['a, b'])).toMatchObject({ ok: false });
    expect(at(['a"b'])).toMatchObject({ ok: false });
  });

  test('blank fields exist for every kind', () => {
    for (const kind of FOUNDATION_EDITOR_TYPES) expect(blankFields(kind).kind).toBe(kind);
  });
});

describe('environment-dependent fonts', () => {
  test('flags named families the probe cannot find, in stack order, never the generics', () => {
    const probe = (family: string) => family === 'Menlo';
    expect(
      environmentDependentFamilies(['Inter', 'Menlo', 'Inter', 'ui-monospace', 'monospace'], probe),
    ).toEqual(['Inter']);
    expect(environmentDependentFamilies('Roboto', () => false)).toEqual(['Roboto']);
    expect(environmentDependentFamilies([], () => false)).toEqual([]);
  });

  test('the editor states it beside each family this browser lacks', async () => {
    await open('font.sans');
    const notices = [...target.querySelectorAll('[data-testid="environment-dependent"]')];
    expect(notices.length).toBeGreaterThan(0);
    expect(notices[0]?.textContent).toContain(ENVIRONMENT_DEPENDENT_NOTICE);
    expect(target.textContent).not.toContain('sans-serif: Environment-dependent');
  });
});

group('the mounted editors', () => {
  scenario(
    'a dimension editor labels every control with the token and context and edits with units',
    async () => {
      const { controller, row } = await open('space.2');
      for (const element of target.querySelectorAll<HTMLElement>('input, select')) {
        const label = target.querySelector(`label[for="${element.id}"]`)?.textContent ?? '';
        if (element.id.endsWith('-scope') || element.id.endsWith('-locked')) continue;
        expect(label).toContain(row.path);
        expect(label).toContain('shared');
      }
      expect(input('-amount').value).toBe('0.5');
      await typeInto(input('-amount'), '12');
      const unit = target.querySelector<HTMLSelectElement>('select[id$="-unit"]')!;
      unit.value = 'px';
      unit.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      await click('Apply');
      expect(shared(controller)).toEqual({
        space: { '2': { $type: 'dimension', $value: { value: 12, unit: 'px' } } },
      });
      expect(controller.draftValues.get(row.cssProperty)).toBe('12px');
      expect(target.querySelector('[data-testid="scale-preview"]')).not.toBeNull();
      expect(
        target.querySelector('[data-testid="scale-preview"] [aria-current="true"]'),
      ).not.toBeNull();
    },
  );

  test('invalid or partial input stays visible, is flagged, and never moves the committed preview', async () => {
    const { controller, workbench } = await open('space.2');
    for (const partial of ['-', '1.2.3', 'abc', '-4']) {
      await typeInto(input('-amount'), partial);
      expect(input('-amount').value).toBe(partial);
      expect(input('-amount').getAttribute('aria-invalid')).toBe('true');
      const described = input('-amount').getAttribute('aria-describedby') ?? '';
      expect(described.length).toBeGreaterThan(0);
    }
    await click('Apply');
    expect(entries(controller)).toBe(0);
    expect(css(controller, 'space.2')).toBe('0.5rem');
    expect(target.querySelector('[data-testid="preview-value"]')?.textContent).toBe('0.5rem');
    expect(workbench.previewIsLastValid).toBe(true);
    expect(controller.draft!.inputBuffer['space.2@source']?.text).toContain('-4');
  });

  test.each([
    ['motion.fast', '-amount', '90', '90ms'],
    ['opacity.disabled', '-amount', '0.3', '0.3'],
    ['font.bold', '-amount', '650', '650'],
    ['ease.standard', '-y1', '0.1', 'cubic-bezier(0.2, 0.1, 0, 1)'],
  ] as const)(
    '%s commits as one undoable, redoable transaction',
    async (path, suffix, text, expected) => {
      const { controller } = await open(path);
      const before = css(controller, path);
      await typeInto(input(suffix), text);
      await click('Apply');
      expect(entries(controller)).toBe(1);
      expect(css(controller, path)).toBe(expected);
      await controller.undo();
      expect(css(controller, path)).toBe(before);
      expect(shared(controller)).toEqual({});
      await controller.redo();
      expect(css(controller, path)).toBe(expected);
    },
  );

  test('a cubic-bezier curve draws the last-valid value, and x outside 0 to 1 is refused', async () => {
    const { controller } = await open('ease.standard');
    const before = target.querySelector('[data-testid="bezier-curve"] path')!.getAttribute('d');
    await typeInto(input('-x1'), '2');
    expect(input('-x1').getAttribute('aria-invalid')).toBe('true');
    expect(target.querySelector('[data-testid="bezier-curve"] path')!.getAttribute('d')).toBe(
      before,
    );
    await click('Apply');
    expect(entries(controller)).toBe(0);
  });

  test('the font stack reorders, adds and removes with buttons and keeps the order it was given', async () => {
    const { controller } = await open('font.mono');
    const names = () =>
      [...target.querySelectorAll<HTMLInputElement>('input[id*="-family-"]')].map((i) => i.value);
    const first = names() as [string, string];
    target.querySelector<HTMLButtonElement>(`button[aria-label="Move ${first[0]} down"]`)!.click();
    await settle();
    expect(names().slice(0, 2)).toEqual([first[1], first[0]]);
    expect(document.activeElement?.id ?? '').toContain('-down-1');
    await typeInto(input('-add'), 'Fira Code');
    await click('Add family');
    expect(names().at(-1)).toBe('Fira Code');
    await click('Apply');
    const node = (shared(controller) as { font: { mono: { $value: string[] } } }).font.mono;
    expect(node.$value.slice(0, 2)).toEqual([first[1], first[0]]);
    expect(node.$value.at(-1)).toBe('Fira Code');
    expect(Array.isArray(node.$value)).toBe(true);
    expect(entries(controller)).toBe(1);
  });

  test('a color-mode-independent edit updates both light and dark', async () => {
    const { controller } = await open('motion.fast');
    await typeInto(input('-amount'), '77');
    await click('Apply');
    expect(css(controller, 'motion.fast')).toBe('77ms');
    await controller.switchContext({ colorMode: 'dark', motion: 'default' });
    expect(css(controller, 'motion.fast')).toBe('77ms');
  });

  scenario(
    'a reduced-motion edit stays in the reduced override and leaves other contexts alone',
    async () => {
      const { controller } = await open('motion.slow', { colorMode: 'light', motion: 'reduced' });
      const scope = target.querySelector<HTMLSelectElement>('select[id$="-scope"]')!;
      scope.value = 'motion-mode';
      scope.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      await typeInto(input('-amount'), '5');
      await click('Apply');
      expect(controller.draft!.envelope.overrides.reduced).toMatchObject({ motion: { slow: {} } });
      expect(controller.draft!.envelope.overrides.forcedReduced).toEqual({});
      expect(shared(controller)).toEqual({});
      expect(css(controller, 'motion.slow')).toBe('5ms');
      await controller.switchContext({ colorMode: 'light', motion: 'default' });
      expect(css(controller, 'motion.slow')).toBe('400ms');
    },
  );

  scenario(
    'an alias is replaced only by an explicit action, and reset removes the override',
    async () => {
      const { controller } = await open('gap.stack');
      expect(target.querySelector('[data-testid="alias-note"]')).not.toBeNull();
      expect(target.querySelector('input[id$="-amount"]')).toBeNull();
      await click('Replace with literal');
      expect(entries(controller)).toBe(0);
      expect(target.querySelector('[data-testid="impact-list"]')).not.toBeNull();
      await applyImpact();
      expect(entries(controller)).toBe(1);
      expect(input('-amount').value).not.toBe('');
      await click('Reset field');
      expect(shared(controller)).toEqual({});
    },
  );

  scenario('a stale detach proposal cannot be applied', async () => {
    const { controller } = await open('gap.stack');
    await click('Replace with literal');
    expect(impactApply()!.disabled).toBe(false);
    await controller.commit({
      kind: 'edit',
      label: 'Elsewhere',
      edit: {
        kind: 'set-override',
        scope: 'shared',
        path: 'space.2',
        node: { $type: 'dimension', $value: { value: 9, unit: 'px' } },
      },
    });
    await settle();
    expect(target.querySelector('[data-testid="impact-stale"]')).not.toBeNull();
    expect(impactApply()!.disabled).toBe(true);
  });

  scenario(
    'reset at field, category and theme works for each family, and is undoable',
    async () => {
      const { controller } = await open('opacity.disabled');
      for (const [path, value] of [
        ['opacity.disabled', { $type: 'number', $value: 0.2 }],
        ['font.bold', { $type: 'fontWeight', $value: 600 }],
        ['motion.fast', { $type: 'duration', $value: { value: 50, unit: 'ms' } }],
        ['ease.standard', { $type: 'cubicBezier', $value: [0.1, 0.1, 0.1, 0.1] }],
        ['space.2', { $type: 'dimension', $value: { value: 1, unit: 'rem' } }],
        ['font.mono', { $type: 'fontFamily', $value: ['monospace'] }],
      ] as Array<[string, JsonObject]>) {
        await controller.commit({
          kind: 'edit',
          label: path,
          edit: { kind: 'set-override', scope: 'shared', path, node: value },
        });
      }
      expect(controller.changedPaths.size).toBe(6);
      await controller.reset({ kind: 'category', prefix: 'motion' }, 'Reset motion');
      expect(controller.changedPaths.has('motion.fast')).toBe(false);
      expect(controller.changedPaths.has('font.bold')).toBe(true);
      await controller.reset({ kind: 'field', path: 'font.bold' }, 'Reset font.bold');
      expect(controller.changedPaths.has('font.bold')).toBe(false);
      await controller.reset({ kind: 'theme' }, 'Reset theme');
      expect(controller.changedPaths.size).toBe(0);
      await controller.undo();
      expect(controller.changedPaths.size).toBeGreaterThan(0);
    },
  );

  scenario('a locked token cannot be edited, and locking is an undoable transaction', async () => {
    const { controller } = await open('space.2');
    const lock = target.querySelector<HTMLInputElement>('input[type="checkbox"][id$="-locked"]')!;
    lock.click();
    await settle();
    expect(controller.lockedPaths.has('space.2')).toBe(true);
    expect(button('Apply').disabled).toBe(true);
    expect(input('-amount').disabled).toBe(true);
    expect(controller.draft!.envelope.locked).toEqual(['space.2']);
    await controller.undo();
    expect(controller.lockedPaths.size).toBe(0);
    expect(controller.draft!.envelope.locked).toBeUndefined();
  });
});

await warmScenarios();
