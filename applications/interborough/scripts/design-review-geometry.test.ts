/**
 * The design review's geometry audit (`scripts/design-review-geometry.ts`): each rule against the
 * smallest set of measured facts that breaks it and the nearest set that does not, the
 * consolidation that turns one defect on forty captures into one line, and the command line.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type ControlFact,
  type GeometryCapture,
  type GeometryFacts,
  GEOMETRY_RULES,
  GEOMETRY_THRESHOLDS,
  auditCapture,
  consolidateFindings,
  inventoryPatterns,
  renderGeometryReport,
} from '@lostgradient/testing/design-review-geometry';
import { auditGeometry, runGeometryAudit } from './design-review-geometry.ts';

const SCALE = [0, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 64];

function facts(overrides: Partial<GeometryFacts> = {}): GeometryFacts {
  return {
    viewport: { width: 1280, height: 800 },
    pointerCoarse: false,
    spaceScale: SCALE,
    controls: [],
    textStyles: [],
    borders: [],
    edges: [],
    stacks: [],
    leadingSpace: [],
    overlaps: [],
    insets: [],
    chrome: null,
    ...overrides,
  };
}

function capture(overrides: Partial<GeometryCapture> = {}): GeometryCapture {
  return {
    route: '/agents',
    state: 'ready',
    source: '00-showcase.spec.ts',
    width: 1280,
    colorScheme: 'light',
    viewport: 'screens/agents--ready--1280--light.png',
    ...overrides,
  };
}

/** A 32-pixel-tall button whose label sits `inline` pixels from each side and `block` from top and bottom. */
function button(inline: number, block: number, overrides: Partial<ControlFact> = {}): ControlFact {
  const height = 32;
  const labelWidth = 40;
  const rect = overrides.rect ?? { x: 100, y: 100, width: labelWidth + inline * 2, height };
  return {
    name: 'button.cinder-button[size=md]',
    kind: 'button',
    text: 'Save',
    accessibleLabel: '',
    hasIcon: false,
    inline: false,
    variant: '',
    rect: { x: 100, y: 100, width: labelWidth + inline * 2, height },
    painted: overrides.painted ?? rect,
    content: { x: 100 + inline, y: 100 + block, width: labelWidth, height: height - block * 2 },
    fontSize: 13,
    extendedHitArea: false,
    fullWidth: false,
    boxed: true,
    labelRuns: 1,
    parent: 0,
    ...overrides,
    // Nothing extends the area that takes a tap, or pads the layout, unless a test says so.
    hit: overrides.hit ?? overrides.layout ?? rect,
    layout: overrides.layout ?? rect,
  };
}

/** Every rule some set of facts in this file has broken, for the coverage test at the end. */
const fired = new Set<string>();

/** {@link auditCapture}, recording which rules the facts broke. */
function audit(...parameters: Parameters<typeof auditCapture>): ReturnType<typeof auditCapture> {
  const found = auditCapture(...parameters);
  for (const finding of found) fired.add(finding.rule);
  return found;
}

function rules(found: readonly { rule: string }[]): string[] {
  return found.map((finding) => finding.rule);
}

describe('button-padding-ratio', () => {
  test('flags a label with as much room above it as beside it', () => {
    const found = audit(facts({ controls: [button(10, 8)] }), capture());
    expect(rules(found)).toEqual(['button-padding-ratio']);
    expect(found[0]?.subject).toBe('button.cinder-button[size=md]');
    expect(found[0]?.measured).toContain('10px beside');
    expect(found[0]?.measured).toContain('8px above');
  });

  test('passes a label with twice the room beside it', () => {
    expect(audit(facts({ controls: [button(16, 8)] }), capture())).toEqual([]);
  });

  test('ignores an icon-only button, a stretched button, a link and a button that draws no box', () => {
    const controls = [
      button(0, 4, { boxed: false }),
      button(8, 8, { text: '', hasIcon: true }),
      button(10, 8, { fullWidth: true }),
      button(10, 8, { kind: 'link' }),
    ];
    expect(audit(facts({ controls }), capture())).toEqual([]);
  });
});

describe('targets on a phone', () => {
  const phone = { viewport: { width: 375, height: 800 } };

  test('flags a single-line button drawn taller than the oversize limit', () => {
    const tall = button(44, 20, {
      rect: { x: 16, y: 100, width: 176, height: 56 },
      content: { x: 60, y: 120, width: 88, height: 16 },
    });
    const found = audit(facts({ ...phone, controls: [tall] }), capture({ width: 375 }));
    expect(rules(found)).toEqual(['target-oversized']);
  });

  test('flags a button drawn at the touch minimum, and passes one drawn compact with a larger hit area', () => {
    const grown = button(40, 14, {
      rect: { x: 16, y: 100, width: 120, height: 44 },
      content: { x: 56, y: 114, width: 40, height: 16 },
    });
    const compact = button(40, 8, {
      rect: { x: 16, y: 200, width: 120, height: 32 },
      content: { x: 56, y: 208, width: 40, height: 16 },
      hit: { x: 16, y: 194, width: 120, height: 44 },
    });
    const touch = { ...phone, pointerCoarse: true };
    const found = audit(facts({ ...touch, controls: [grown, compact] }), capture({ width: 375 }));
    expect(rules(found)).toEqual(['target-oversized']);
    expect(found[0]?.measured).toContain('drawn 44px tall, over the 36px limit');
  });

  test('judges a button that draws no box by its hit area alone, and other controls by the looser limit', () => {
    const ghost = button(10, 14, {
      boxed: false,
      rect: { x: 16, y: 108, width: 60, height: 28 },
      content: { x: 26, y: 114, width: 40, height: 16 },
      hit: { x: 16, y: 100, width: 60, height: 44 },
    });
    const row = button(10, 14, {
      kind: 'other',
      rect: { x: 16, y: 200, width: 343, height: 44 },
      content: { x: 26, y: 214, width: 40, height: 16 },
    });
    const touch = { ...phone, pointerCoarse: true };
    expect(audit(facts({ ...touch, controls: [ghost, row] }), capture({ width: 375 }))).toEqual([]);
  });

  test('does not call the same button oversized at desktop width', () => {
    const tall = button(44, 20, {
      rect: { x: 16, y: 100, width: 176, height: 56 },
      content: { x: 60, y: 120, width: 88, height: 16 },
    });
    expect(audit(facts({ controls: [tall] }), capture())).toEqual([]);
  });

  test('flags a short label stretched across the phone', () => {
    const wide = button(150, 8, {
      rect: { x: 16, y: 100, width: 343, height: 32 },
      content: { x: 166, y: 108, width: 40, height: 16 },
      fullWidth: true,
    });
    const found = audit(facts({ ...phone, controls: [wide] }), capture({ width: 375 }));
    expect(rules(found)).toEqual(['button-stretched']);
  });

  test('flags a long label as a candidate for an icon, but never from the stress data', () => {
    const wordy = button(16, 8, { text: 'Open conversation settings' });
    const controls = [wordy, { ...wordy, name: 'button.row', labelRuns: 3 }];
    expect(rules(audit(facts({ ...phone, controls }), capture({ width: 375 })))).toEqual([
      'button-wordy',
    ]);
    expect(
      audit(facts({ ...phone, controls }), capture({ width: 375, source: 'responsive.spec.ts' })),
    ).toEqual([]);
  });
});

describe('target-undersized', () => {
  const small = button(4, 4, {
    text: '',
    hasIcon: true,
    rect: { x: 10, y: 10, width: 20, height: 20 },
    content: { x: 14, y: 14, width: 12, height: 12 },
  });

  test('flags a control smaller than the minimum on either axis', () => {
    expect(rules(audit(facts({ controls: [small] }), capture()))).toEqual(['target-undersized']);
  });

  test('passes one with an extended hit area, and a link inside a sentence', () => {
    const controls = [
      { ...small, hit: { x: 8, y: 8, width: 24, height: 24 } },
      { ...small, kind: 'link' as const, inline: true },
    ];
    expect(audit(facts({ controls }), capture())).toEqual([]);
  });

  test('holds the hit area to the touch minimum on a touch screen, but not a text field', () => {
    const adequate = button(8, 4, {
      rect: { x: 10, y: 10, width: 56, height: 24 },
      content: { x: 18, y: 14, width: 40, height: 16 },
    });
    const field = { ...adequate, kind: 'field' as const, name: 'input.cinder-input' };
    const extended = { ...adequate, hit: { x: 10, y: 0, width: 56, height: 44 } };
    expect(audit(facts({ controls: [adequate] }), capture())).toEqual([]);
    const found = audit(
      facts({ pointerCoarse: true, controls: [adequate, field, extended] }),
      capture(),
    );
    expect(rules(found)).toEqual(['target-undersized']);
    expect(found[0]?.measured).toContain('under the 44px minimum on a touch screen');
  });
});

describe('hit-takes-space', () => {
  const touch = { pointerCoarse: true };
  const padded = { x: 90, y: 94, width: 76, height: 44 };

  test('flags a compact face inside a 44 pixel layout box, and measures padding from the face', () => {
    // 8 pixels beside the label and 6 above on a 28 pixel face, padded to 44 by a transparent border.
    const deny = button(8, 6, {
      text: 'Deny',
      rect: { x: 100, y: 100, width: 56, height: 28 },
      content: { x: 108, y: 106, width: 40, height: 16 },
      layout: padded,
    });
    const found = audit(facts({ ...touch, controls: [deny] }), capture({ width: 375 }));
    expect(rules(found)).toEqual(['button-padding-ratio', 'hit-takes-space']);
    expect(found[0]?.measured).toContain('8px beside the label, 6px above');
    expect(found[1]?.measured).toBe('"Deny" paints 28px tall and takes 44px in the layout');
  });

  test('flags a bare button whose layout box is taller than the limit', () => {
    const bare = button(0, 0, {
      boxed: false,
      content: { x: 100, y: 114, width: 40, height: 16 },
      layout: padded,
    });
    expect(rules(audit(facts({ ...touch, controls: [bare] }), capture()))).toEqual([
      'hit-takes-space',
    ]);
  });

  test('passes a compact face whose hit area takes no space, and any button under a mouse', () => {
    const extended = button(16, 8, { hit: padded });
    expect(audit(facts({ ...touch, controls: [extended] }), capture())).toEqual([]);
    const mouse = button(16, 8, { layout: padded });
    expect(audit(facts({ controls: [mouse] }), capture())).toEqual([]);
  });
});

describe('inventoryPatterns', () => {
  const retry = (text: string, overrides: Partial<ControlFact> = {}): ControlFact =>
    button(16, 8, { text, ...overrides });

  test('lists a job asked with several labels and drawn in several forms, per pointer', () => {
    const entries = inventoryPatterns([
      { facts: facts({ controls: [retry('Retry')] }), capture: capture() },
      {
        facts: facts({ controls: [retry('Try again', { variant: 'ghost', boxed: false })] }),
        capture: capture({ route: '/runs', viewport: 'screens/runs.png' }),
      },
      { facts: facts({ controls: [retry('Save'), retry('Save')] }), capture: capture() },
    ]);
    expect(entries).toEqual([
      {
        job: 'retry',
        labels: ['Retry', 'Try again'],
        forms: [
          'button.cinder-button[size=md] 32px boxed',
          'button.cinder-button[size=md][variant=ghost] 16px bare',
        ],
        pointer: 'mouse',
        examples: ['screens/agents--ready--1280--light.png', 'screens/runs.png'],
      },
    ]);
  });

  test('keeps touch and mouse apart, allows two forms of one label, and skips the stress pages', () => {
    const tall = retry('Retry', { rect: { x: 0, y: 0, width: 72, height: 44 } });
    expect(
      inventoryPatterns([
        { facts: facts({ controls: [retry('Retry')] }), capture: capture() },
        { facts: facts({ pointerCoarse: true, controls: [tall] }), capture: capture() },
        {
          facts: facts({ controls: [retry('Try again')] }),
          capture: capture({ source: 'responsive.spec.ts' }),
        },
      ]),
    ).toEqual([]);
  });
});

describe('icon-pitch', () => {
  function icon(x: number, overrides: Partial<ControlFact> = {}): ControlFact {
    return button(0, 0, {
      text: '',
      accessibleLabel: 'Copy',
      hasIcon: true,
      boxed: false,
      rect: { x, y: 100, width: 44, height: 44 },
      content: { x: x + 15, y: 115, width: 14, height: 14 },
      ...overrides,
    });
  }

  test('flags icon buttons whose glyphs sit several glyphs apart', () => {
    const found = audit(facts({ controls: [icon(0), icon(48), icon(96)] }), capture());
    expect(rules(found)).toEqual(['icon-pitch']);
    expect(found[0]?.measured).toContain('14px glyphs 48px apart');
  });

  test('passes glyphs close together, icons in different rows or parents, and the two ends of a bar', () => {
    const tight = [icon(0), icon(32)];
    const rows = [
      icon(0, { parent: 1 }),
      icon(0, { parent: 1, rect: { x: 0, y: 300, width: 44, height: 44 } }),
    ];
    const parents = [icon(200, { parent: 2 }), icon(300, { parent: 3 })];
    const ends = [icon(0, { parent: 4 }), icon(300, { parent: 4 })];
    expect(audit(facts({ controls: [...tight, ...rows, ...parents, ...ends] }), capture())).toEqual(
      [],
    );
  });
});

describe('type', () => {
  function style(fontSize: number, lineHeight: number | null, multiline = false) {
    return { fontSize, lineHeight, fontWeight: 400, count: 4, multiline, sample: 'Sample' };
  }

  test('flags a page that uses more sizes than the limit', () => {
    const sizes = [11, 12, 13, 14, 16, 18, 20, 24];
    const found = audit(
      facts({ textStyles: sizes.map((size) => style(size, size * 1.5)) }),
      capture(),
    );
    expect(rules(found)).toEqual(['type-sizes']);
    expect(found[0]?.measured).toContain('8 sizes');
  });

  test('flags wrapped text set tighter or looser than the readable range', () => {
    const found = audit(
      facts({ textStyles: [style(14, 15, true), style(14, 28, true), style(14, 21, true)] }),
      capture(),
    );
    expect(rules(found)).toEqual(['line-height', 'line-height', 'line-height-mixed']);
  });

  test('does not judge the line height of text that never wraps', () => {
    expect(audit(facts({ textStyles: [style(13, 13)] }), capture())).toEqual([]);
  });

  test('ignores text set at no size, and a ratio that only rounding puts out of range', () => {
    const textStyles = [style(0, 0), style(13, 16.9, true)];
    expect(audit(facts({ textStyles }), capture())).toEqual([]);
  });

  test('flags text below the smallest readable size', () => {
    expect(rules(audit(facts({ textStyles: [style(9, 12)] }), capture()))).toEqual(['text-tiny']);
  });
});

describe('borders', () => {
  function border(contrast: number, interactive: boolean, width = 1, name = 'div.cinder-card') {
    return { name, width, style: 'solid', contrast, interactive, count: 3 };
  }

  test('flags a structural border heavier than a hairline should be', () => {
    const found = audit(facts({ borders: [border(2.4, false)] }), capture());
    expect(rules(found)).toEqual(['border-heavy']);
  });

  test('holds a control border to the looser control limit', () => {
    expect(audit(facts({ borders: [border(2.9, true)] }), capture())).toEqual([]);
    expect(rules(audit(facts({ borders: [border(3.2, true)] }), capture()))).toEqual([
      'border-heavy',
    ]);
  });

  test('flags a border thicker than one pixel', () => {
    expect(rules(audit(facts({ borders: [border(1.2, false, 2)] }), capture()))).toEqual([
      'border-thick',
    ]);
  });

  test('flags a page whose structural borders come in too many weights', () => {
    const borders = [1.1, 1.2, 1.3, 1.4].map((contrast, index) =>
      border(contrast, false, 1, `div.card-${index}`),
    );
    expect(rules(audit(facts({ borders }), capture()))).toEqual(['border-mixed']);
  });

  test('counts a dashed border as a weight of its own', () => {
    const solid = [1.1, 1.2, 1.3].map((contrast, index) =>
      border(contrast, false, 1, `div.card-${index}`),
    );
    expect(audit(facts({ borders: solid }), capture())).toEqual([]);
    const found = audit(
      facts({ borders: [...solid, { ...border(1.3, false, 1, 'div.queued'), style: 'dashed' }] }),
      capture(),
    );
    expect(rules(found)).toEqual(['border-mixed']);
    expect(found[0]?.measured).toContain('dashed 1.3:1');
  });
});

describe('edge-near-miss', () => {
  function edge(x: number, count: number, name: string) {
    return { x, count, samples: [name] };
  }

  test('flags two left edges a few pixels apart', () => {
    const found = audit(
      facts({ edges: [edge(24, 6, 'h2.title'), edge(26, 3, 'p.summary'), edge(200, 4, 'td')] }),
      capture(),
    );
    expect(rules(found)).toEqual(['edge-near-miss']);
    expect(found[0]?.measured).toContain('24px');
    expect(found[0]?.measured).toContain('26px');
  });

  test('treats sub-pixel differences as aligned, and a lone element as noise', () => {
    const edges = [edge(24, 6, 'h2'), edge(24.5, 3, 'p'), edge(27, 1, 'span')];
    expect(audit(facts({ edges }), capture())).toEqual([]);
  });
});

function stack(
  name: string,
  uniformChildren: boolean,
  gaps: readonly number[],
  edges: { lefts?: readonly number[]; rights?: readonly number[] } = {},
) {
  return { name, uniformChildren, gaps, lefts: [], rights: [], ...edges };
}

describe('edge-many', () => {
  test('flags children that start on more left edges, or end on more right edges, than the limit', () => {
    const stacks = [
      stack('div.chat-column', false, [8, 8, 8], { lefts: [12, 20, 37, 45] }),
      stack('div.transcript', false, [8, 8], { rights: [605, 688, 752] }),
    ];
    const found = audit(facts({ stacks }), capture());
    expect(rules(found)).toEqual(['edge-many', 'edge-many']);
    expect(found[0]?.measured).toContain('4 left edges: 12px, 20px, 37px, 45px');
    expect(found[1]?.subject).toBe('div.transcript right edges');
  });

  test('passes two edges, edges a pixel apart, and never judges the stress data', () => {
    const stacks = [stack('section.panel', false, [8, 8], { lefts: [16, 16.5, 17, 40] })];
    expect(audit(facts({ stacks }), capture())).toEqual([]);
    const many = [stack('section.panel', false, [8, 8], { lefts: [16, 24, 40] })];
    expect(audit(facts({ stacks: many }), capture({ source: 'responsive.spec.ts' }))).toEqual([]);
  });
});

describe('occluded', () => {
  function overlap(kind: 'covered' | 'faded' | 'over-text', amount: number) {
    return {
      kind,
      subject: 'button.cinder-button[size=sm]',
      label: 'Approve',
      by: 'div.bar',
      amount,
    };
  }

  test('flags a control partly covered, one under a fade, and one lying on text', () => {
    const overlaps = [overlap('covered', 0.4), overlap('faded', 0.5), overlap('over-text', 0.9)];
    const found = audit(facts({ overlaps }), capture());
    expect(rules(found)).toEqual(['occluded', 'occluded', 'occluded']);
    expect(found.map((finding) => finding.subject)).toEqual([
      'button.cinder-button[size=sm] under div.bar',
      'button.cinder-button[size=sm] under the fade of div.bar',
      'button.cinder-button[size=sm] over div.bar',
    ]);
  });

  test('passes a fade that only grazes a control', () => {
    expect(audit(facts({ overlaps: [overlap('faded', 0.1)] }), capture())).toEqual([]);
  });
});

describe('inset-uneven', () => {
  test('flags a box with more room above its content than below, past the tolerance', () => {
    const insets = [
      { name: 'div.cinder-alert', above: 26, below: 12, sample: 'Answer incomplete' },
      { name: 'div.cinder-card', above: 16, below: 12, sample: 'Even enough' },
    ];
    const found = audit(facts({ insets }), capture());
    expect(rules(found)).toEqual(['inset-uneven']);
    expect(found[0]?.measured).toContain('26px above');
    expect(audit(facts({ insets }), capture({ source: 'responsive.spec.ts' }))).toEqual([]);
  });
});

describe('chrome-share', () => {
  const chrome = { name: 'div.chat-timeline', top: 8, bottom: 292 };

  test('flags fixed chrome that takes more than its share of a phone', () => {
    const found = audit(
      facts({ viewport: { width: 320, height: 640 }, chrome }),
      capture({ width: 320 }),
    );
    expect(rules(found)).toEqual(['chrome-share']);
    expect(found[0]?.measured).toContain('46%');
  });

  test('passes a one-line composer, and the same chrome on a desktop', () => {
    const small = { ...chrome, bottom: 122 };
    expect(
      audit(facts({ viewport: { width: 320, height: 640 }, chrome: small }), capture()),
    ).toEqual([]);
    expect(audit(facts({ chrome }), capture())).toEqual([]);
  });
});

describe('gaps', () => {
  test('flags a gap between siblings that is not a step of the spacing scale', () => {
    const stacks = [stack('section.panel', false, [16, 18, 16])];
    const found = audit(facts({ stacks }), capture());
    expect(rules(found)).toEqual(['gap-off-scale']);
    expect(found[0]?.measured).toContain('18px');
  });

  test('flags like siblings spaced unevenly', () => {
    const stacks = [stack('ul.list', true, [8, 12, 8])];
    expect(rules(audit(facts({ stacks }), capture()))).toEqual(['gap-uneven']);
  });

  test('treats a gap wider than the slack limit as layout, not spacing', () => {
    const stacks = [stack('ul.navigation', false, [2, 101])];
    expect(audit(facts({ stacks }), capture())).toEqual([]);
  });

  test('does not hold gaps to a scale the probe could not read', () => {
    const stacks = [stack('section.panel', false, [16, 18, 16])];
    expect(audit(facts({ spaceScale: [0], stacks }), capture())).toEqual([]);
    const report = renderGeometryReport([], { captures: 1, measured: 1, coarse: 1, unscaled: 1 });
    expect(report).toContain('1 measured captures declared no `--cinder-space-*` scale');
  });

  test('passes unlike siblings spaced by different steps of the scale', () => {
    const stacks = [stack('article', false, [8, 24, 16])];
    expect(audit(facts({ stacks }), capture())).toEqual([]);
  });
});

describe('leading-space', () => {
  const row = {
    name: 'div.row',
    width: 343,
    leading: 180,
    trailing: 0,
    within: null,
    sample: 'Open',
  };

  test('flags a row whose content starts far from its leading edge', () => {
    const found = audit(
      facts({ viewport: { width: 375, height: 800 }, leadingSpace: [row] }),
      capture({ width: 375 }),
    );
    expect(rules(found)).toEqual(['leading-space']);
    expect(found[0]?.measured).toContain('52%');
  });

  test('reports a row inside a broken row once, and a broken row inside a passing one', () => {
    const passing = { ...row, name: 'section.wrapper', leading: 24 };
    const inner = { ...row, name: 'div.inner', within: 1 };
    const deeper = { ...row, name: 'div.deeper', within: 2 };
    const found = audit(
      facts({ leadingSpace: [passing, { ...row, within: 0 }, inner, deeper] }),
      capture(),
    );
    expect(found.map((finding) => finding.subject)).toEqual(['div.row']);
  });

  test('passes centered content, and never judges the stress data', () => {
    const centered = { ...row, leading: 120, trailing: 120 };
    expect(audit(facts({ leadingSpace: [centered] }), capture())).toEqual([]);
    expect(
      audit(facts({ leadingSpace: [row] }), capture({ source: 'responsive.spec.ts' })),
    ).toEqual([]);
  });
});

describe('consolidateFindings', () => {
  test('folds one defect seen on many captures into one line that lists where', () => {
    const controls = [button(10, 8)];
    const findings = [
      ...audit(facts({ controls }), capture()),
      ...audit(
        facts({ controls }),
        capture({ route: '/runs', width: 375, viewport: 'screens/runs--ready--375--light.png' }),
      ),
    ];
    const consolidated = consolidateFindings(findings);
    expect(consolidated).toHaveLength(1);
    expect(consolidated[0]?.captures).toBe(2);
    expect(consolidated[0]?.widths).toEqual([375, 1280]);
    expect(consolidated[0]?.routes).toEqual(['/agents', '/runs']);
    expect(consolidated[0]?.examples).toEqual([
      'screens/agents--ready--1280--light.png',
      'screens/runs--ready--375--light.png',
    ]);
  });

  test('orders rules as the report lists them, the most widespread subject first', () => {
    const found = consolidateFindings([
      ...audit(
        facts({
          textStyles: [
            {
              fontSize: 9,
              lineHeight: 12,
              fontWeight: 400,
              count: 1,
              multiline: false,
              sample: 'x',
            },
          ],
        }),
        capture(),
      ),
      ...audit(facts({ controls: [button(10, 8)] }), capture()),
    ]);
    expect(found.map((finding) => finding.rule)).toEqual(['button-padding-ratio', 'text-tiny']);
  });
});

describe('renderGeometryReport', () => {
  test('names each rule, its threshold and where it was seen', () => {
    const consolidated = consolidateFindings(
      audit(facts({ controls: [button(10, 8)] }), capture()),
    );
    const report = renderGeometryReport(consolidated, {
      captures: 1,
      measured: 1,
      coarse: 0,
      unscaled: 0,
    });
    expect(report).toContain('# Geometry audit');
    expect(report).toContain('## Button padding ratio');
    expect(report).toContain(`${GEOMETRY_THRESHOLDS.buttonPaddingRatioMinimum}`);
    expect(report).toContain('button.cinder-button[size=md]');
    expect(report).toContain('screens/agents--ready--1280--light.png');
  });

  test('says so when nothing was found, and when no capture emulated touch', () => {
    const report = renderGeometryReport([], { captures: 2, measured: 2, coarse: 0, unscaled: 0 });
    expect(report).toContain('No findings.');
    expect(report).toContain('No capture emulated a coarse pointer');
  });
});

describe('auditGeometry', () => {
  const directories: string[] = [];
  afterAll(async () => {
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true })));
  });

  async function captureDirectory(lines: readonly object[]): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'design-review-geometry-'));
    directories.push(directory);
    await mkdir(join(directory, 'geometry'));
    await writeFile(
      join(directory, 'manifest.jsonl'),
      lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
    );
    return directory;
  }

  test('reads the manifest, audits each measured capture and writes both reports', async () => {
    const directory = await captureDirectory([
      { ...capture(), geometry: 'geometry/agents.json' },
      { ...capture({ route: '/runs' }) },
    ]);
    await writeFile(
      join(directory, 'geometry', 'agents.json'),
      JSON.stringify(facts({ controls: [button(10, 8)] })),
    );
    const result = await auditGeometry(directory);
    expect(result).toEqual({ captures: 2, measured: 1, coarse: 0, unscaled: 0, findings: 1 });
    const written = JSON.parse(await readFile(join(directory, 'geometry-findings.json'), 'utf8'));
    expect(written.findings[0].rule).toBe('button-padding-ratio');
    expect(await readFile(join(directory, 'geometry-report.md'), 'utf8')).toContain(
      'Button padding ratio',
    );
  });

  test('answers nothing measured for a directory with no manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'design-review-geometry-'));
    directories.push(directory);
    expect(await auditGeometry(directory)).toEqual({
      captures: 0,
      measured: 0,
      coarse: 0,
      unscaled: 0,
      findings: 0,
    });
  });

  test('the command line refuses bad usage, an unmeasured directory, and reports a measured one', async () => {
    const written = { out: '', error: '' };
    const write = {
      out: (text: string) => {
        written.out += text;
      },
      error: (text: string) => {
        written.error += text;
      },
    };
    expect(await runGeometryAudit([], write)).toBe(2);
    expect(written.error).toContain('usage: bun scripts/design-review-geometry.ts');

    const empty = await captureDirectory([capture()]);
    expect(await runGeometryAudit(['--capture', empty], write)).toBe(1);
    expect(written.error).toContain(`no measured capture in ${empty}`);

    const measured = await captureDirectory([{ ...capture(), geometry: 'geometry/agents.json' }]);
    await writeFile(join(measured, 'geometry', 'agents.json'), JSON.stringify(facts()));
    expect(await runGeometryAudit(['--capture', measured], write)).toBe(0);
    expect(written.out).toContain('0 geometry findings from 1 measured captures');
  });
});

// Last in the file on purpose: it reads what every test above fired.
describe('every rule', () => {
  test('is broken by some set of facts in this file, so none passes only because it cannot fail', () => {
    expect([...fired].toSorted()).toEqual(Object.keys(GEOMETRY_RULES).toSorted());
  });
});
