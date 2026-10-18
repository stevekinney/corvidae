/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { flushSync, mount, tick, unmount } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

import { catalogueRowByPath } from './theme-builder-catalogue.ts';
import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import CompositeEditor from './theme-composite-editor.svelte';
import {
  COMPOSITE_TYPES,
  compositeFromValue,
  compositeToValue,
  moved,
  type CompositeType,
  type Layer,
} from './theme-composite-values.ts';
import { editableState, type JsonObject, type JsonValue } from './theme-draft-types.ts';
import { jsonEquals } from './theme-override-tree.ts';
import { fixtureEnvelope, SOURCE_TOKENS } from './theme-reference-fixtures.ts';
import { memoEvaluator as evaluator, warmStates } from './theme-reference-test-support.ts';
import { sourceTokenRow } from './theme-source-token-row.ts';
import { editorForToken } from './theme-token-editors.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

setupHappyDom();

const FX = SOURCE_TOKENS['fx'] as Record<string, JsonObject>;
const valueOf = (name: string): JsonValue => FX[name]!['$value']!;

const FIXTURES: ReadonlyArray<[CompositeType, string]> = [
  ['shadow', 'fx.shadow'],
  ['gradient', 'fx.gradient'],
  ['border', 'fx.border'],
  ['transition', 'fx.transition'],
  ['strokeStyle', 'fx.stroke'],
  ['typography', 'fx.typography'],
];

describe('the field model round-trips every fixture exactly', () => {
  test.each(FIXTURES)('%s keeps member order, references, units and key order', (type, path) => {
    const original = valueOf(path.slice(3));
    const fields = compositeFromValue(type, original);
    expect(fields).not.toBeNull();
    const rebuilt = compositeToValue(fields!);
    expect(rebuilt.ok).toBe(true);
    expect(JSON.stringify(rebuilt.ok ? rebuilt.value : null)).toBe(JSON.stringify(original));
  });

  test('a named strokeStyle and a single-object shadow round-trip', () => {
    const named = compositeFromValue('strokeStyle', 'dashed')!;
    expect(compositeToValue(named)).toEqual({ ok: true, value: 'dashed' });
    const single = {
      color: { colorSpace: 'srgb', components: [0, 0, 0] },
      offsetX: { value: 0, unit: 'px' },
      offsetY: { value: 0, unit: 'px' },
      blur: { value: 1, unit: 'px' },
      spread: { value: 0, unit: 'px' },
    };
    const fields = compositeFromValue('shadow', single)!;
    expect(compositeToValue(fields)).toEqual({ ok: true, value: single });
  });

  test('unknown member keys and their order survive', () => {
    const value = {
      z: 1,
      width: { value: 1, unit: 'px' },
      color: { colorSpace: 'srgb', components: [0, 0, 0] },
      style: 'solid',
      a: [1, 2],
    };
    const rebuilt = compositeToValue(compositeFromValue('border', value)!);
    expect(JSON.stringify(rebuilt.ok ? rebuilt.value : null)).toBe(JSON.stringify(value));
  });

  test('array order is the field order: moving a layer moves exactly that layer', () => {
    const fields = compositeFromValue('shadow', valueOf('shadow'))!;
    if (fields.type !== 'shadow') throw new Error('shape');
    const swapped = { ...fields, layers: moved(fields.layers, 0, 1) };
    const result = compositeToValue(swapped);
    const original = valueOf('shadow') as JsonValue[];
    expect(result).toEqual({ ok: true, value: [original[1]!, original[0]!] });
  });

  test('a reference member is kept verbatim, and an unreadable member is preserved', () => {
    const value = { ...(valueOf('border') as JsonObject), width: { $ref: '#/fx/a/$value' } };
    const rebuilt = compositeToValue(compositeFromValue('border', value)!);
    expect(rebuilt).toEqual({ ok: true, value });
    const odd = { ...(valueOf('border') as JsonObject), width: 'wide' };
    expect(compositeToValue(compositeFromValue('border', odd)!)).toEqual({ ok: true, value: odd });
  });

  test('a whole-token reference is not a composite literal', () => {
    for (const type of COMPOSITE_TYPES) expect(compositeFromValue(type, '{fx.shadow}')).toBeNull();
  });
});

describe('malformed members are named by path', () => {
  function errorsFor(type: CompositeType, change: (value: JsonValue) => JsonValue) {
    const name = FIXTURES.find(([kind]) => kind === type)![1].slice(3);
    const fields = compositeFromValue(type, change(structuredClone(valueOf(name))))!;
    const result = compositeToValue(fields);
    return result.ok ? {} : result.errors;
  }
  const layer = (value: JsonValue, index: number) => (value as JsonObject[])[index]!;

  /** Fields whose scalar text was typed wrongly: the text is kept, so the value is rejected. */
  function typed(
    type: 'shadow' | 'transition' | 'typography',
    member: string,
    amount: string,
    at = 0,
  ) {
    const fields = compositeFromValue(type, valueOf(type))!;
    const target =
      fields.type === 'shadow' ? fields.layers[at]! : (fields as { layer: Layer }).layer;
    const entry = target.members[member] as { fields: { amount: string } };
    entry.fields.amount = amount;
    const result = compositeToValue(fields);
    return result.ok ? {} : result.errors;
  }

  test('shadow: a bad blur and a negative blur', () => {
    expect(Object.keys(typed('shadow', 'blur', 'abc', 1))).toEqual(['layers.1.blur']);
    expect(typed('shadow', 'blur', '-2')['layers.0.blur']).toContain('Cinder limit');
  });

  test('shadow: an unparseable color; gradient: a position beyond 1 and fewer than two stops', () => {
    const color = compositeFromValue('shadow', valueOf('shadow'))!;
    if (color.type !== 'shadow') throw new Error('shape');
    color.layers[0]!.members['color'] = { kind: 'color', text: 'not a color', original: null };
    const colorResult = compositeToValue(color);
    expect(colorResult.ok ? [] : Object.keys(colorResult.errors)).toEqual(['layers.0.color']);

    const stops = compositeFromValue('gradient', valueOf('gradient'))!;
    if (stops.type !== 'gradient') throw new Error('shape');
    const position = stops.layers[2]!.members['position'] as { fields: { amount: string } };
    position.fields.amount = '2';
    const far = compositeToValue(stops);
    expect(far.ok ? '' : far.errors['layers.2.position']).toContain('Cinder limit');
    const one = errorsFor('gradient', (value) => [layer(value, 0)]);
    expect(one['layers']).toBe('A gradient needs at least two stops.');
  });

  test('strokeStyle: an unknown name, an empty dash array, an unknown cap', () => {
    const named = compositeToValue(compositeFromValue('strokeStyle', 'banana')!);
    expect(named.ok ? {} : named.errors).toHaveProperty('stroke');
    const empty = errorsFor('strokeStyle', () => ({ dashArray: [], lineCap: 'round' }));
    expect(empty['stroke']).toBe('Add at least one dash length.');
    const cap = errorsFor('strokeStyle', (value) => ({
      ...(value as JsonObject),
      lineCap: 'pointy',
    }));
    expect(cap['stroke.lineCap']).toContain('round');
  });

  test('transition: a bezier x outside 0..1; typography: a zero font size and a bad weight', () => {
    const bezier = errorsFor('transition', (value) => {
      (value as JsonObject)['timingFunction'] = [2, 0, 0.2, 1];
      return value;
    });
    expect(bezier['timingFunction']).toContain('between 0 and 1');
    expect(typed('typography', 'lineHeight', '-1')['lineHeight']).toContain('Cinder limit');
    expect(typed('typography', 'fontWeight', 'heavyish')['fontWeight']).toContain('heavyish');
  });
});

describe('the registry', () => {
  test.each([...COMPOSITE_TYPES])('%s resolves to the composite editor', (type) => {
    expect(editorForToken(sourceTokenRow(`fx.${type}`, type))).toBe(CompositeEditor);
  });
});

// --- the mounted editor ---------------------------------------------------------------------

// The states the controllers below start over are evaluated here, outside any test's budget.
await warmStates(SOURCE_TOKENS);
let mounted: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

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

/** A controller seeded with the fixture Source tokens, and the editor mounted on one of them. */
async function open(path: string, type: string) {
  const workbench = new ThemeWorkbenchState();
  const controller = new ThemeBuilderController({ workbench, evaluator, persistence: null });
  await controller.start();
  const seeded = await controller.commit({
    kind: 'edit',
    label: 'Seed',
    state: editableState(fixtureEnvelope()),
  });
  expect(seeded.ok).toBe(true);
  const row = { ...sourceTokenRow(path, type), themeAware: true };
  mounted = mount(CompositeEditor, { target, props: { controller, workbench, row } });
  await settle();
  return { controller, workbench, row };
}

const input = (suffix: string) => target.querySelector<HTMLInputElement>(`input[id$="${suffix}"]`)!;
const buttons = (label: string) =>
  [...target.querySelectorAll('button')].filter(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label,
  );
const button = (label: string) => buttons(label)[0]!;

async function typeInto(element: HTMLInputElement, text: string): Promise<void> {
  element.value = text;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
}

async function click(label: string): Promise<void> {
  button(label).click();
  await settle();
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
}

const lightNode = (controller: ThemeBuilderController, path: string) =>
  (controller.draft!.envelope.overrides.light['fx'] as JsonObject | undefined)?.[path.slice(3)] as
    JsonObject | undefined;
const entries = (controller: ThemeBuilderController) => controller.history!.entries.length;

describe('shadow layers', () => {
  test('every member of every layer is a labeled field with the token and scope in its name', async () => {
    await open('fx.shadow', 'shadow');
    const layers = target.querySelectorAll('[data-testid="composite-layer"]');
    expect(layers).toHaveLength(2);
    for (const member of ['offsetX', 'offsetY', 'blur', 'spread']) {
      expect(input(`layer-0-${member}-amount`)).not.toBeNull();
    }
    // Layer 2's offsetX is a reference, shown as one rather than as a number.
    for (const member of ['offsetY', 'blur', 'spread']) {
      expect(input(`layer-1-${member}-amount`)).not.toBeNull();
    }
    const blur = input('layer-0-blur-amount');
    const label = target.querySelector(`label[for="${blur.id}"]`)!.textContent;
    expect(label).toContain('Fx shadow');
    expect(label).toContain('fx.shadow');
    expect(label).toContain('layer 1');
    expect(label).toContain('blur');
  });

  test('editing one member rewrites only that member and keeps references and flags', async () => {
    const { controller } = await open('fx.shadow', 'shadow');
    await typeInto(input('layer-0-blur-amount'), '6');
    await click('Apply');
    const node = lightNode(controller, 'fx.shadow')!;
    expect(node['$type']).toBe('shadow');
    const original = valueOf('shadow') as JsonObject[];
    const value = node['$value'] as JsonObject[];
    expect(value[0]).toEqual({ ...original[0], blur: { value: 6, unit: 'px' } });
    expect(value[1]).toEqual(original[1]);
    expect(value[1]!['offsetX']).toBe('{fx.a}');
    expect(value[1]!['inset']).toBe(true);
    expect(controller.history!.entries).toHaveLength(2);
  });

  test('Move down reorders the layers, announces it, and moves focus with the layer', async () => {
    const { controller } = await open('fx.shadow', 'shadow');
    const down = buttons('Move Shadow layer 1 down')[0]!;
    down.focus();
    down.click();
    await settle();
    expect(controller.announcement).toBe('Moved Shadow layer 1 to position 2 of 2');
    expect(document.activeElement?.id).toMatch(/layer-up-1$/);
    await click('Apply');
    const original = valueOf('shadow') as JsonObject[];
    expect(lightNode(controller, 'fx.shadow')!['$value']).toEqual([original[1]!, original[0]!]);
  });

  test('a reference member is shown as one and only an explicit action makes it a literal', async () => {
    const { controller } = await open('fx.shadow', 'shadow');
    expect(target.textContent).toContain('{fx.a}');
    expect(input('layer-1-offsetX-amount')).toBeNull();
    expect(buttons('Apply')[0]!.hasAttribute('disabled')).toBe(true);
    await typeInto(input('layer-1-blur-amount'), '10');
    await click('Apply');
    expect((lightNode(controller, 'fx.shadow')!['$value'] as JsonObject[])[1]!['offsetX']).toBe(
      '{fx.a}',
    );
    await click(
      'Replace Fx shadow (fx.shadow, light mode) shadow layer 2 offset x reference with a literal',
    );
    expect(input('layer-1-offsetX-amount').value).toBe('4');
    await click('Apply');
    expect((lightNode(controller, 'fx.shadow')!['$value'] as JsonObject[])[1]!['offsetX']).toEqual({
      value: 4,
      unit: 'px',
    });
  });

  test('a malformed member keeps its text, names its path, and changes nothing', async () => {
    const { controller } = await open('fx.shadow', 'shadow');
    const revision = controller.draft!.revision;
    await typeInto(input('layer-0-blur-amount'), 'abc');
    expect(input('layer-0-blur-amount').getAttribute('aria-invalid')).toBe('true');
    await click('Apply');
    expect(input('layer-0-blur-amount').value).toBe('abc');
    expect(controller.draft!.revision).toBe(revision);
    expect(entries(controller)).toBe(1);
    expect(target.querySelector('[data-testid="composite-error"]')).not.toBeNull();
  });

  test('Add layer appends a layer; Apply then Undo restores the exact overrides', async () => {
    const { controller } = await open('fx.shadow', 'shadow');
    const before = controller.draft!.envelope.overrides;
    await click('Add a shadow layer to Fx shadow (fx.shadow, light mode)');
    expect(target.querySelectorAll('[data-testid="composite-layer"]')).toHaveLength(3);
    await click('Apply');
    expect((lightNode(controller, 'fx.shadow')!['$value'] as JsonValue[]).length).toBe(3);
    await controller.undo();
    expect(jsonEquals(controller.draft!.envelope.overrides, before)).toBe(true);
  });

  test('Reset field on a public shadow removes the override and the shipped value comes back', async () => {
    const workbench = new ThemeWorkbenchState();
    const controller = new ThemeBuilderController({ workbench, evaluator, persistence: null });
    await controller.start();
    const row = catalogueRowByPath('shadow.medium')!;
    mounted = mount(CompositeEditor, { target, props: { controller, workbench, row } });
    await settle();
    const shipped = controller.draftValues.get(row.cssProperty);
    await typeInto(input('layer-0-blur-amount'), '9');
    await click('Apply');
    expect(controller.draftValues.get(row.cssProperty)).not.toBe(shipped);
    await click('Reset field');
    expect(controller.draftValues.get(row.cssProperty)).toBe(shipped);
    expect(controller.draft!.envelope.overrides.light).toEqual({});
    await controller.undo();
    expect(controller.draftValues.get(row.cssProperty)).not.toBe(shipped);
  });
});

describe('the other composites', () => {
  test('border: width, color and style are all editable and style survives', async () => {
    const { controller } = await open('fx.border', 'border');
    await typeInto(input('width-amount'), '3');
    await click('Replace Fx border (fx.border, light mode) color reference with a literal');
    await typeInto(input('color-text'), 'oklch(0.5 0.2 270)');
    await choose(target.querySelector<HTMLSelectElement>('select[id$="style-named"]')!, 'dashed');
    await click('Apply');
    expect(lightNode(controller, 'fx.border')!['$value']).toEqual({
      color: { colorSpace: 'oklch', components: [0.5, 0.2, 270] },
      width: { value: 3, unit: 'px' },
      style: 'dashed',
    });
  });

  test('border: the color reference stays until the author replaces it', async () => {
    const { controller } = await open('fx.border', 'border');
    expect(target.textContent).toContain('{surface.base}');
    await typeInto(input('width-amount'), '2');
    await click('Apply');
    expect((lightNode(controller, 'fx.border')!['$value'] as JsonObject)['color']).toBe(
      '{surface.base}',
    );
  });

  test('transition: duration, delay and the four bezier points', async () => {
    const { controller } = await open('fx.transition', 'transition');
    await typeInto(input('duration-amount'), '300');
    await typeInto(input('delay-amount'), '50');
    await typeInto(input('timingFunction-y1'), '0.1');
    await click('Apply');
    expect(lightNode(controller, 'fx.transition')!['$value']).toEqual({
      duration: { value: 300, unit: 'ms' },
      delay: { value: 50, unit: 'ms' },
      timingFunction: [0.4, 0.1, 0.2, 1],
    });
  });

  test('gradient: stops reorder with the keyboard; a stop cannot drop below two', async () => {
    const { controller } = await open('fx.gradient', 'gradient');
    expect(target.querySelectorAll('[data-testid="composite-layer"]')).toHaveLength(3);
    await click('Move Gradient stop 3 up');
    // Stops must stay in nondecreasing position order, so the move alone is rejected, by path.
    await click('Apply');
    expect(lightNode(controller, 'fx.gradient')).toBeUndefined();
    expect(target.querySelector('[data-testid="composite-error"]')?.textContent).toContain(
      'gradient positions must be nondecreasing',
    );
    await typeInto(input('layer-1-position-amount'), '0.5');
    await typeInto(input('layer-2-position-amount'), '1');
    await click('Apply');
    const original = valueOf('gradient') as JsonObject[];
    expect(lightNode(controller, 'fx.gradient')!['$value']).toEqual([
      original[0]!,
      { ...original[2]!, position: 0.5 },
      { ...original[1]!, position: 1 },
    ]);
    await click('Remove Gradient stop 1');
    expect(target.querySelectorAll('[data-testid="composite-layer"]')).toHaveLength(2);
    expect(buttons('Remove Gradient stop 1')[0]!.hasAttribute('disabled')).toBe(true);
  });

  test('strokeStyle: the dash array reorders and keeps its reference', async () => {
    const { controller } = await open('fx.stroke', 'strokeStyle');
    await click('Move Fx stroke (fx.stroke, light mode) stroke dash 3 up');
    await click('Apply');
    expect(lightNode(controller, 'fx.stroke')!['$value']).toEqual({
      dashArray: [{ value: 2, unit: 'px' }, { value: 6, unit: 'px' }, '{fx.a}'],
      lineCap: 'round',
    });
  });

  test('strokeStyle: a named style switches to the structured form and back', async () => {
    const { controller } = await open('fx.strokeNamed', 'strokeStyle');
    expect(target.querySelector<HTMLSelectElement>('select[id$="-named"]')!.value).toBe('dashed');
    await choose(target.querySelector<HTMLSelectElement>('select[id$="-form"]')!, 'dashed');
    expect(target.querySelector('[id$="-add-dash"]')).not.toBeNull();
    await choose(target.querySelector<HTMLSelectElement>('select[id$="-form"]')!, 'named');
    expect(target.querySelector<HTMLSelectElement>('select[id$="-named"]')!.value).toBe('dashed');
    expect(controller.draft!.revision).toBeGreaterThan(0);
  });

  test('typography: family order, size reference, weight and line height', async () => {
    const { controller } = await open('fx.typography', 'typography');
    await typeInto(input('fontWeight-amount'), 'bold');
    await typeInto(input('lineHeight-amount'), '1.6');
    await click('Move system-ui up');
    await click('Apply');
    const value = lightNode(controller, 'fx.typography')!['$value'] as JsonObject;
    expect(value['fontFamily']).toEqual(['system-ui', 'Inter', 'sans-serif']);
    expect(value['fontSize']).toBe('{fx.a}');
    expect(value['fontWeight']).toBe('bold');
    expect(value['lineHeight']).toBe(1.6);
    expect(value['letterSpacing']).toEqual({ value: 0.5, unit: 'px' });
  });
});

describe('a public composite token', () => {
  test('shadow.small edits through the same editor and changes the preview value', async () => {
    const workbench = new ThemeWorkbenchState();
    const controller = new ThemeBuilderController({ workbench, evaluator, persistence: null });
    await controller.start();
    const row = catalogueRowByPath('shadow.small')!;
    expect(editorForToken(row)).toBe(CompositeEditor);
    mounted = mount(CompositeEditor, { target, props: { controller, workbench, row } });
    await settle();
    const shipped = controller.draftValues.get(row.cssProperty);
    await typeInto(input('layer-0-blur-amount'), '5');
    await click('Apply');
    expect(controller.draftValues.get(row.cssProperty)).not.toBe(shipped);
    expect(controller.draftValues.get(row.cssProperty)).toContain('5px');
    await controller.undo();
    expect(controller.draftValues.get(row.cssProperty)).toBe(shipped);
  });
});
