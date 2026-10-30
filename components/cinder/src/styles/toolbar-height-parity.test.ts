/**
 * One control height scale (COR-1814). Button, Input, SearchField, Select,
 * Combobox, MultiSelect, and SegmentedControl read the same
 * `--cinder-control-height-*` step for the same `size`, so a row of controls
 * of one size lines up, and a toolbar Chip and a toolbar SegmentedControl
 * match a small Button. Each control's outer height is resolved here from the
 * declarations its stylesheet makes for that size, through the generated
 * token stylesheet, so a drift in any control, or in the tokens between them,
 * fails.
 *
 * A declared `min-height` is not a rendered height: a field whose padding and
 * line box add up to more than the step renders taller than its token, which
 * is how a medium SearchField came to be 38px beside a 36px Select. The field
 * rows therefore also check that the block padding, the line box, and the
 * 1px border fit inside the step.
 *
 * Textarea takes `size` for its padding only: it is several lines tall, so it
 * has no place in a row of single-line controls.
 */

import { describe, expect, test } from 'bun:test';
import { parse, type AtRule, type Root, type Rule } from 'postcss';

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();
const ROOT_FONT_SIZE = 16;
const BORDER = 1;
const SIZES = ['sm', 'md', 'lg'] as const;
type Size = (typeof SIZES)[number];

const rootValues = new Map<string, string>();
parse(await read('./tokens-base.css')).walkRules((rule: Rule) => {
  if (rule.selector !== ':root') return;
  rule.walkDecls((declaration) => {
    if (declaration.prop.startsWith('--')) rootValues.set(declaration.prop, declaration.value);
  });
});

const sheets = new Map<string, Root>();
async function sheet(path: string): Promise<Root> {
  const cached = sheets.get(path);
  if (cached) return cached;
  const parsed = parse(await read(path));
  sheets.set(path, parsed);
  return parsed;
}

/** The declarations of every top-level rule with exactly this selector, later ones winning. */
async function declarations(path: string, selector: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const stylesheet = await sheet(path);
  stylesheet.walkRules((rule: Rule) => {
    if (rule.parent?.type === 'atrule' && (rule.parent as AtRule).name === 'media') return;
    if (rule.selector.replace(/\s+/g, ' ') !== selector) return;
    rule.walkDecls((declaration) => {
      found.set(declaration.prop, declaration.value);
    });
  });
  return found;
}

/** Substitutes `var()` references from the rule's own custom properties, then `:root`. */
function substitute(value: string, local: Map<string, string>, seen = new Set<string>()): string {
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g, (_match, name: string) => {
    if (seen.has(name)) throw new Error(`alias cycle at ${name}`);
    const next = local.get(name) ?? rootValues.get(name);
    if (next === undefined) throw new Error(`${name} is not declared`);
    return substitute(next, local, new Set([...seen, name]));
  });
}

/** A length in pixels from a `rem`/`px` literal or a `calc()` of sums and differences of them. */
function pixels(value: string): number {
  const expression = value.trim().replace(/^calc\((.*)\)$/s, '$1');
  let total = 0;
  for (const [, sign, amount, unit] of expression.matchAll(/([+-]?)\s*(\d*\.?\d+)(rem|px)?/g)) {
    const magnitude = Number(amount) * (unit === 'rem' ? ROOT_FONT_SIZE : 1);
    total += sign === '-' ? -magnitude : magnitude;
  }
  return total;
}

function resolvePixels(value: string, local: Map<string, string>): number {
  return pixels(substitute(value, local));
}

type ControlRow = {
  /** Stylesheet path relative to this file. */
  path: string;
  /** Selector of the element that carries the size, and of its base rule. */
  base: string;
  /** Selector of the element whose height is declared, when it is a descendant of `base`. */
  part?: string;
  /** The height property the stylesheet declares. */
  property: 'min-height' | 'min-block-size';
  /** Pixels the frame around the declared element adds to the outer height. */
  frame: number;
};

const button: ControlRow = {
  path: '../components/button/button.css',
  base: '.cinder-button',
  property: 'min-height',
  frame: 0,
};
const input: ControlRow = {
  path: '../components/input/input.css',
  base: '.cinder-input',
  property: 'min-height',
  frame: 0,
};
/** SearchField renders an Input with a leading icon, so its input sits in a 1px-bordered group. */
const searchField: ControlRow = {
  path: '../components/input/input.css',
  base: '.cinder-input',
  part: '.cinder-input-group > .cinder-input',
  property: 'min-height',
  frame: 2 * BORDER,
};
const select: ControlRow = {
  path: '../components/select/select.css',
  base: '.cinder-select',
  property: 'min-height',
  frame: 0,
};
const combobox: ControlRow = {
  path: '../components/combobox/combobox.css',
  base: '.cinder-combobox__input',
  property: 'min-height',
  frame: 0,
};
const multiSelect: ControlRow = {
  path: '../components/multi-select/multi-select.css',
  base: '.cinder-multi-select__trigger',
  property: 'min-height',
  frame: 0,
};
/** An attached SegmentedControl wraps its options in a 1px border and 1px padding. */
const segmentedControl: ControlRow = {
  path: '../components/segmented-control/segmented-control.css',
  base: '.cinder-segmented-control',
  part: '.cinder-segmented-control-option',
  property: 'min-block-size',
  frame: 4 * BORDER,
};

const rows = {
  button,
  input,
  searchField,
  select,
  combobox,
  multiSelect,
  segmentedControl,
} as const;

/** The base rule's declarations overlaid with the size rule's, as the cascade applies them. */
async function sizedDeclarations(row: ControlRow, size: Size): Promise<Map<string, string>> {
  const sized = `${row.base}[data-cinder-size='${size}']`;
  const merged = new Map([
    ...(await declarations(row.path, row.base)),
    ...(await declarations(row.path, sized)),
  ]);
  if (row.part) {
    for (const selector of [`${row.base} ${row.part}`, `${sized} ${row.part}`, row.part]) {
      for (const [property, value] of await declarations(row.path, selector)) {
        merged.set(property, value);
      }
    }
  }
  return merged;
}

async function outerHeight(row: ControlRow, size: Size): Promise<number> {
  const merged = await sizedDeclarations(row, size);
  const declared = merged.get(row.property);
  if (declared === undefined) {
    throw new Error(`${row.base} declares no ${row.property} for size ${size} in ${row.path}`);
  }
  return resolvePixels(declared, merged) + row.frame;
}

function controlHeight(size: Size): number {
  return pixels(substitute(`var(--cinder-control-height-${size})`, new Map()));
}

describe('one control height scale', () => {
  test('the scale is 24, 28, 32 and 40px', () => {
    expect(
      ['xs', ...SIZES].map((size) =>
        pixels(substitute(`var(--cinder-control-height-${size})`, new Map())),
      ),
    ).toEqual([24, 28, 32, 40]);
  });

  for (const size of SIZES) {
    test(`every control is ${controlHeight(size)}px tall at size ${size}`, async () => {
      const heights: Record<string, number> = {};
      for (const [name, row] of Object.entries(rows)) heights[name] = await outerHeight(row, size);
      const expected = Object.fromEntries(
        Object.keys(rows).map((name) => [name, controlHeight(size)]),
      );
      expect(heights).toEqual(expected);
    });
  }

  test('each Button size aliases the shared control height', () => {
    for (const size of ['xs', ...SIZES]) {
      expect(rootValues.get(`--cinder-button-height-${size}`)).toBe(
        `var(--cinder-control-height-${size})`,
      );
    }
  });
});

describe('field content fits inside the step', () => {
  /** The tallest thing on a control's single line: its text line box, MultiSelect's count badge, or a Button's icon. */
  const fields = {
    input: { row: input, lineBox: 'calc(var(--cinder-text-sm) * var(--cinder-leading-normal))' },
    select: { row: select, lineBox: 'calc(var(--cinder-text-sm) * var(--cinder-leading-normal))' },
    combobox: {
      row: combobox,
      lineBox: 'calc(var(--cinder-text-sm) * var(--cinder-leading-normal))',
    },
    multiSelect: { row: multiSelect, lineBox: '1.25rem' },
    // A Button's tallest content is a `cinder-icon-sm` (16px) leading or trailing icon.
    button: { row: button, lineBox: '1rem' },
  } as const;

  function lineBoxPixels(value: string): number {
    const product = /^calc\((.+)\s\*\s(.+)\)$/.exec(substitute(value, new Map()));
    if (!product) return pixels(substitute(value, new Map()));
    return pixels(product[1]!) * Number(product[2]);
  }

  for (const size of SIZES) {
    for (const [name, { row, lineBox }] of Object.entries(fields)) {
      test(`${name} at size ${size}: padding, line box, and border stay inside the height`, async () => {
        const merged = await sizedDeclarations(row, size);
        const blockPadding =
          merged.get('padding-block') ?? merged.get('padding')?.split(/\s+(?![^(]*\))/)[0];
        if (blockPadding === undefined) throw new Error(`${row.base} declares no block padding`);
        const content =
          2 * resolvePixels(blockPadding, merged) + lineBoxPixels(lineBox) + 2 * BORDER;
        expect(content).toBeLessThanOrEqual(controlHeight(size));
      });
    }
  }
});

describe('toolbar row heights', () => {
  test('Button sm, SegmentedControl toolbar, and Chip toolbar are the same height', async () => {
    const chip = await declarations(
      '../components/chip/chip.css',
      ".cinder-chip[data-cinder-density='toolbar']",
    );
    expect({
      button: await outerHeight(button, 'sm'),
      // density="toolbar" resolves to data-cinder-size="sm" in the component.
      segmentedControl: await outerHeight(segmentedControl, 'sm'),
      chip: resolvePixels(chip.get('min-block-size') ?? '', chip),
    }).toEqual({ button: 28, segmentedControl: 28, chip: 28 });
  });
});
