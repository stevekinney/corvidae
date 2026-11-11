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
  GEOMETRY_THRESHOLDS,
  auditCapture,
  auditGeometry,
  consolidateFindings,
  renderGeometryReport,
  runGeometryAudit,
} from './design-review-geometry.ts';

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
  return {
    name: 'button.cinder-button[size=md]',
    kind: 'button',
    text: 'Save',
    accessibleLabel: '',
    hasIcon: false,
    inline: false,
    rect: { x: 100, y: 100, width: labelWidth + inline * 2, height },
    content: { x: 100 + inline, y: 100 + block, width: labelWidth, height: height - block * 2 },
    fontSize: 13,
    extendedHitArea: false,
    fullWidth: false,
    boxed: true,
    labelRuns: 1,
    ...overrides,
  };
}

function rules(found: readonly { rule: string }[]): string[] {
  return found.map((finding) => finding.rule);
}

describe('button-padding-ratio', () => {
  test('flags a label with as much room above it as beside it', () => {
    const found = auditCapture(facts({ controls: [button(10, 8)] }), capture());
    expect(rules(found)).toEqual(['button-padding-ratio']);
    expect(found[0]?.subject).toBe('button.cinder-button[size=md]');
    expect(found[0]?.measured).toContain('10px beside');
    expect(found[0]?.measured).toContain('8px above');
  });

  test('passes a label with twice the room beside it', () => {
    expect(auditCapture(facts({ controls: [button(16, 8)] }), capture())).toEqual([]);
  });

  test('ignores an icon-only button, a stretched button, a link and a button that draws no box', () => {
    const controls = [
      button(0, 4, { boxed: false }),
      button(8, 8, { text: '', hasIcon: true }),
      button(10, 8, { fullWidth: true }),
      button(10, 8, { kind: 'link' }),
    ];
    expect(auditCapture(facts({ controls }), capture())).toEqual([]);
  });
});

describe('targets on a phone', () => {
  const phone = { viewport: { width: 375, height: 800 } };

  test('flags a single-line button drawn taller than the oversize limit', () => {
    const tall = button(44, 20, {
      rect: { x: 16, y: 100, width: 176, height: 56 },
      content: { x: 60, y: 120, width: 88, height: 16 },
    });
    const found = auditCapture(facts({ ...phone, controls: [tall] }), capture({ width: 375 }));
    expect(rules(found)).toEqual(['target-oversized']);
  });

  test('does not call the same button oversized at desktop width', () => {
    const tall = button(44, 20, {
      rect: { x: 16, y: 100, width: 176, height: 56 },
      content: { x: 60, y: 120, width: 88, height: 16 },
    });
    expect(auditCapture(facts({ controls: [tall] }), capture())).toEqual([]);
  });

  test('flags a short label stretched across the phone', () => {
    const wide = button(150, 8, {
      rect: { x: 16, y: 100, width: 343, height: 32 },
      content: { x: 166, y: 108, width: 40, height: 16 },
      fullWidth: true,
    });
    const found = auditCapture(facts({ ...phone, controls: [wide] }), capture({ width: 375 }));
    expect(rules(found)).toEqual(['button-stretched']);
  });

  test('flags a long label as a candidate for an icon, but never from the stress data', () => {
    const wordy = button(16, 8, { text: 'Open conversation settings' });
    const controls = [wordy, { ...wordy, name: 'button.row', labelRuns: 3 }];
    expect(rules(auditCapture(facts({ ...phone, controls }), capture({ width: 375 })))).toEqual([
      'button-wordy',
    ]);
    expect(
      auditCapture(
        facts({ ...phone, controls }),
        capture({ width: 375, source: 'responsive.spec.ts' }),
      ),
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
    expect(rules(auditCapture(facts({ controls: [small] }), capture()))).toEqual([
      'target-undersized',
    ]);
  });

  test('passes one with an extended hit area, and a link inside a sentence', () => {
    const controls = [
      { ...small, extendedHitArea: true },
      { ...small, kind: 'link' as const, inline: true },
    ];
    expect(auditCapture(facts({ controls }), capture())).toEqual([]);
  });
});

describe('type', () => {
  function style(fontSize: number, lineHeight: number | null, multiline = false) {
    return { fontSize, lineHeight, fontWeight: 400, count: 4, multiline, sample: 'Sample' };
  }

  test('flags a page that uses more sizes than the limit', () => {
    const sizes = [11, 12, 13, 14, 16, 18, 20, 24];
    const found = auditCapture(
      facts({ textStyles: sizes.map((size) => style(size, size * 1.5)) }),
      capture(),
    );
    expect(rules(found)).toEqual(['type-sizes']);
    expect(found[0]?.measured).toContain('8 sizes');
  });

  test('flags wrapped text set tighter or looser than the readable range', () => {
    const found = auditCapture(
      facts({ textStyles: [style(14, 15, true), style(14, 28, true), style(14, 21, true)] }),
      capture(),
    );
    expect(rules(found)).toEqual(['line-height', 'line-height', 'line-height-mixed']);
  });

  test('does not judge the line height of text that never wraps', () => {
    expect(auditCapture(facts({ textStyles: [style(13, 13)] }), capture())).toEqual([]);
  });

  test('ignores text set at no size, and a ratio that only rounding puts out of range', () => {
    const textStyles = [style(0, 0), style(13, 16.9, true)];
    expect(auditCapture(facts({ textStyles }), capture())).toEqual([]);
  });

  test('flags text below the smallest readable size', () => {
    expect(rules(auditCapture(facts({ textStyles: [style(9, 12)] }), capture()))).toEqual([
      'text-tiny',
    ]);
  });
});

describe('borders', () => {
  function border(contrast: number, interactive: boolean, width = 1, name = 'div.cinder-card') {
    return { name, width, contrast, interactive, count: 3 };
  }

  test('flags a structural border heavier than a hairline should be', () => {
    const found = auditCapture(facts({ borders: [border(2.4, false)] }), capture());
    expect(rules(found)).toEqual(['border-heavy']);
  });

  test('holds a control border to the looser control limit', () => {
    expect(auditCapture(facts({ borders: [border(3.2, true)] }), capture())).toEqual([]);
    expect(rules(auditCapture(facts({ borders: [border(5.2, true)] }), capture()))).toEqual([
      'border-heavy',
    ]);
  });

  test('flags a border thicker than one pixel', () => {
    expect(rules(auditCapture(facts({ borders: [border(1.2, false, 2)] }), capture()))).toEqual([
      'border-thick',
    ]);
  });

  test('flags a page whose structural borders come in too many weights', () => {
    const borders = [1.1, 1.2, 1.3, 1.4].map((contrast, index) =>
      border(contrast, false, 1, `div.card-${index}`),
    );
    expect(rules(auditCapture(facts({ borders }), capture()))).toEqual(['border-mixed']);
  });
});

describe('edge-near-miss', () => {
  function edge(x: number, count: number, name: string) {
    return { x, count, samples: [name] };
  }

  test('flags two left edges a few pixels apart', () => {
    const found = auditCapture(
      facts({ edges: [edge(24, 6, 'h2.title'), edge(26, 3, 'p.summary'), edge(200, 4, 'td')] }),
      capture(),
    );
    expect(rules(found)).toEqual(['edge-near-miss']);
    expect(found[0]?.measured).toContain('24px');
    expect(found[0]?.measured).toContain('26px');
  });

  test('treats sub-pixel differences as aligned, and a lone element as noise', () => {
    const edges = [edge(24, 6, 'h2'), edge(24.5, 3, 'p'), edge(27, 1, 'span')];
    expect(auditCapture(facts({ edges }), capture())).toEqual([]);
  });
});

describe('gaps', () => {
  test('flags a gap between siblings that is not a step of the spacing scale', () => {
    const stacks = [{ name: 'section.panel', uniformChildren: false, gaps: [16, 18, 16] }];
    const found = auditCapture(facts({ stacks }), capture());
    expect(rules(found)).toEqual(['gap-off-scale']);
    expect(found[0]?.measured).toContain('18px');
  });

  test('flags like siblings spaced unevenly', () => {
    const stacks = [{ name: 'ul.list', uniformChildren: true, gaps: [8, 12, 8] }];
    expect(rules(auditCapture(facts({ stacks }), capture()))).toEqual(['gap-uneven']);
  });

  test('treats a gap wider than the slack limit as layout, not spacing', () => {
    const stacks = [{ name: 'ul.navigation', uniformChildren: false, gaps: [2, 101] }];
    expect(auditCapture(facts({ stacks }), capture())).toEqual([]);
  });

  test('does not hold gaps to a scale the probe could not read', () => {
    const stacks = [{ name: 'section.panel', uniformChildren: false, gaps: [16, 18, 16] }];
    expect(auditCapture(facts({ spaceScale: [0], stacks }), capture())).toEqual([]);
    const report = renderGeometryReport([], { captures: 1, measured: 1, coarse: 1, unscaled: 1 });
    expect(report).toContain('1 measured captures declared no `--cinder-space-*` scale');
  });

  test('passes unlike siblings spaced by different steps of the scale', () => {
    const stacks = [{ name: 'article', uniformChildren: false, gaps: [8, 24, 16] }];
    expect(auditCapture(facts({ stacks }), capture())).toEqual([]);
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
    const found = auditCapture(
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
    const found = auditCapture(
      facts({ leadingSpace: [passing, { ...row, within: 0 }, inner, deeper] }),
      capture(),
    );
    expect(found.map((finding) => finding.subject)).toEqual(['div.row']);
  });

  test('passes centered content, and never judges the stress data', () => {
    const centered = { ...row, leading: 120, trailing: 120 };
    expect(auditCapture(facts({ leadingSpace: [centered] }), capture())).toEqual([]);
    expect(
      auditCapture(facts({ leadingSpace: [row] }), capture({ source: 'responsive.spec.ts' })),
    ).toEqual([]);
  });
});

describe('consolidateFindings', () => {
  test('folds one defect seen on many captures into one line that lists where', () => {
    const controls = [button(10, 8)];
    const findings = [
      ...auditCapture(facts({ controls }), capture()),
      ...auditCapture(
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
      ...auditCapture(
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
      ...auditCapture(facts({ controls: [button(10, 8)] }), capture()),
    ]);
    expect(found.map((finding) => finding.rule)).toEqual(['button-padding-ratio', 'text-tiny']);
  });
});

describe('renderGeometryReport', () => {
  test('names each rule, its threshold and where it was seen', () => {
    const consolidated = consolidateFindings(
      auditCapture(facts({ controls: [button(10, 8)] }), capture()),
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
