/**
 * The design review's geometry audit (`.agents/skills/design-review`). A reviewer reading a
 * screenshot cannot tell a two-pixel misalignment from none, or a button whose label has as much
 * room above it as beside it, so a capture also measures each page (`tests/e2e/design-review-geometry-probe.ts`
 * writes the facts beside the screenshots) and this script holds them to the thresholds the rubric
 * states (`references/rubric.md` "Craft"). It writes `geometry-findings.json` and
 * `geometry-report.md` into the capture directory; one defect seen on forty captures is one line
 * naming where.
 *
 *   bun scripts/design-review-geometry.ts --capture <capture directory>
 *
 * `scripts/design-review-capture.ts` runs it after every capture. Exit 0 when the reports were
 * written, 1 when the directory holds no measured capture, 2 on bad usage. A finding is a measured
 * fact, not a verdict: the reviewer confirms it on the screenshot and routes it, because a
 * threshold cannot see intent (a deliberately indented quotation, a primary action meant to span a
 * phone).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** A box in CSS pixels, in page coordinates. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One control the page shows: a button, a link, a field, or another widget a person operates. */
export interface ControlFact {
  /** The tag and first class, with a Cinder size when it has one: `button.cinder-button[size=md]`. */
  readonly name: string;
  readonly kind: 'button' | 'link' | 'field' | 'other';
  /** The visible label, collapsed and cut to sixty characters; empty for an icon-only control. */
  readonly text: string;
  /** The `aria-label` or `title`, which names an icon-only control. */
  readonly accessibleLabel: string;
  readonly hasIcon: boolean;
  /** Whether it is laid out inline in a sentence, which WCAG 2.5.8 exempts from the target size. */
  readonly inline: boolean;
  readonly rect: Box;
  /** The union of the visible text and icons inside, or `null` when it draws nothing of its own. */
  readonly content: Box | null;
  readonly fontSize: number;
  /** Whether a positioned pseudo-element extends the area that takes a tap beyond what is drawn. */
  readonly extendedHitArea: boolean;
  /** Whether it fills its container's inline size and at least half the viewport. */
  readonly fullWidth: boolean;
  /** Whether it draws a box of its own, a border or a fill, so its padding is something a person sees. */
  readonly boxed: boolean;
  /** How many separate runs of text it holds: one for a label, more for a row that is a button. */
  readonly labelRuns: number;
}

/** One combination of size, line height and weight the page sets text in. */
export interface TextStyleFact {
  readonly fontSize: number;
  /** The computed line height in pixels, or `null` for `normal`. */
  readonly lineHeight: number | null;
  readonly fontWeight: number;
  /** How many runs of text use it. */
  readonly count: number;
  /** Whether any of those runs wraps onto a second line, which is when line height shows. */
  readonly multiline: boolean;
  readonly sample: string;
}

/** One border as drawn: who draws it, how thick, and how strongly it reads against its ground. */
export interface BorderFact {
  readonly name: string;
  readonly width: number;
  /** The WCAG contrast ratio of the border, composited, against the surface outside it. */
  readonly contrast: number;
  /** Whether the element is a control, whose boundary WCAG 1.4.11 covers. */
  readonly interactive: boolean;
  readonly count: number;
}

/** A left edge that content starts at, and how much content starts there. */
export interface EdgeFact {
  readonly x: number;
  readonly count: number;
  readonly samples: readonly string[];
}

/** The vertical gaps between the stacked children of one container. */
export interface StackFact {
  readonly name: string;
  /** Whether every child is the same kind of element, so their gaps should match. */
  readonly uniformChildren: boolean;
  readonly gaps: readonly number[];
}

/** A wide row whose content starts well inside its leading edge. */
export interface LeadingSpaceFact {
  readonly name: string;
  /** The row's content-box inline size. */
  readonly width: number;
  /** The empty distance from the row's leading edge to its first content. */
  readonly leading: number;
  /** The empty distance from its last content to its trailing edge. */
  readonly trailing: number;
  /** The index, in the same list, of the nearest row around this one, or `null` for an outermost row. */
  readonly within: number | null;
  readonly sample: string;
}

/** What the probe measured on one captured page. */
export interface GeometryFacts {
  readonly viewport: { readonly width: number; readonly height: number };
  /** Whether the page matched `(pointer: coarse)`, so its touch-only styles applied. */
  readonly pointerCoarse: boolean;
  /** Cinder's spacing scale in pixels, read from the page's `--cinder-space-*` properties. */
  readonly spaceScale: readonly number[];
  readonly controls: readonly ControlFact[];
  readonly textStyles: readonly TextStyleFact[];
  readonly borders: readonly BorderFact[];
  readonly edges: readonly EdgeFact[];
  readonly stacks: readonly StackFact[];
  readonly leadingSpace: readonly LeadingSpaceFact[];
}

/** The fields of a manifest line the audit reads. */
export interface GeometryCapture {
  readonly route: string;
  readonly state: string;
  readonly tab?: string;
  readonly source: string;
  readonly width: number;
  readonly colorScheme: 'light' | 'dark';
  readonly viewport: string;
  /** The measured facts, relative to the capture directory; absent on a capture taken without the probe. */
  readonly geometry?: string;
}

/**
 * The numbers the audit holds a page to. The rubric's "Craft" section states each one as a rule and
 * cites this object, so a threshold changes here and nowhere else.
 */
export const GEOMETRY_THRESHOLDS = {
  /** A button label needs at least this many times the room beside it as above it. */
  buttonPaddingRatioMinimum: 1.5,
  /** At or below this viewport width a page is a phone layout. */
  phoneWidthMaximum: 480,
  /** A single-line control drawn taller than this on a phone is oversized. */
  phoneControlHeightMaximum: 48,
  /** A button this share of a phone's width, with a label this short, is stretched. */
  stretchedButtonWidthShare: 0.8,
  shortLabelCharacters: 16,
  /** A control smaller than this on either axis, with no extended hit area, fails WCAG 2.5.8. */
  targetMinimum: 24,
  /** A page that sets text in more sizes than this has no type scale. */
  fontSizesMaximum: 6,
  /** Wrapped text reads best with a line height in this range, as a multiple of its size. */
  lineHeightRatioMinimum: 1.3,
  lineHeightRatioMaximum: 1.7,
  /** Above this size text is a display heading, which may be set tighter. */
  bodyFontSizeMaximum: 20,
  /** One size of wrapped text in more line heights than this is inconsistent. */
  lineHeightsPerSizeMaximum: 2,
  /** Text smaller than this is not readable. */
  fontSizeMinimum: 11,
  /** A border between surface and content should read no more strongly than this. */
  structuralBorderContrastMaximum: 1.5,
  /** A control's border should read no more strongly than this. */
  controlBorderContrastMaximum: 4.5,
  /** A border thicker than this is weight, not separation. */
  borderWidthMaximum: 1,
  /** A page drawing structural borders in more weights than this is inconsistent. */
  structuralBorderWeightsMaximum: 3,
  /** Left edges closer than the first are aligned; up to the second they are a near miss. */
  edgeAlignedWithin: 1,
  edgeNearMissWithin: 4,
  /** A gap wider than this is slack a layout hands out (a spacer, `margin: auto`), not spacing. */
  gapSlackAbove: 64,
  /** A row whose content starts this far in, as a share of its width, wastes its leading side. */
  leadingSpaceShare: 0.25,
  leadingSpaceMinimum: 48,
  /** Content with this much less room after it than before it is pushed, not centered. */
  leadingSpaceImbalanceShare: 0.15,
} as const;

/** Every rule, in the order the report lists them, with the heading and the principle it states. */
export const GEOMETRY_RULES = {
  'edge-near-miss': {
    title: 'Near-miss alignment',
    principle: `Content starts on shared left edges. Two edges between ${GEOMETRY_THRESHOLDS.edgeAlignedWithin} and ${GEOMETRY_THRESHOLDS.edgeNearMissWithin} pixels apart are a mistake, not a decision.`,
  },
  'gap-off-scale': {
    title: 'Gaps off the spacing scale',
    principle: "Every gap between siblings is a step of Cinder's spacing scale.",
  },
  'gap-uneven': {
    title: 'Uneven gaps between like siblings',
    principle: 'Siblings of one kind sit at one distance from each other.',
  },
  'leading-space': {
    title: 'Empty leading side',
    principle: `A row's content starts at its leading edge. Content that starts more than ${GEOMETRY_THRESHOLDS.leadingSpaceShare * 100}% of the way across leaves the side a person reads first empty.`,
  },
  'button-padding-ratio': {
    title: 'Button padding ratio',
    principle: `A button's label has at least ${GEOMETRY_THRESHOLDS.buttonPaddingRatioMinimum} times the room beside it as above it; two times is the target.`,
  },
  'target-oversized': {
    title: 'Oversized controls on a phone',
    principle: `A single-line control is drawn no taller than ${GEOMETRY_THRESHOLDS.phoneControlHeightMaximum} pixels on a phone. A touch target grows through its hit area, not its drawn size.`,
  },
  'button-stretched': {
    title: 'Short labels stretched across a phone',
    principle: `A button with a label of ${GEOMETRY_THRESHOLDS.shortLabelCharacters} characters or fewer does not span ${GEOMETRY_THRESHOLDS.stretchedButtonWidthShare * 100}% of a phone unless it is the one primary action of a form or dialog.`,
  },
  'button-wordy': {
    title: 'Wordy buttons on a phone',
    principle: `A phone button's label is ${GEOMETRY_THRESHOLDS.shortLabelCharacters} characters or fewer. A longer one is a candidate for an icon with an accessible label and a tooltip.`,
  },
  'target-undersized': {
    title: 'Undersized targets',
    principle: `A control is at least ${GEOMETRY_THRESHOLDS.targetMinimum} by ${GEOMETRY_THRESHOLDS.targetMinimum} pixels, or extends its hit area that far (WCAG 2.5.8).`,
  },
  'type-sizes': {
    title: 'Too many type sizes',
    principle: `A page sets text in at most ${GEOMETRY_THRESHOLDS.fontSizesMaximum} sizes.`,
  },
  'line-height': {
    title: 'Line height out of range',
    principle: `Wrapped text up to ${GEOMETRY_THRESHOLDS.bodyFontSizeMaximum} pixels has a line height between ${GEOMETRY_THRESHOLDS.lineHeightRatioMinimum} and ${GEOMETRY_THRESHOLDS.lineHeightRatioMaximum} times its size.`,
  },
  'line-height-mixed': {
    title: 'One size, several line heights',
    principle: `Wrapped text of one size uses at most ${GEOMETRY_THRESHOLDS.lineHeightsPerSizeMaximum} line heights on a page.`,
  },
  'text-tiny': {
    title: 'Text too small',
    principle: `No text is smaller than ${GEOMETRY_THRESHOLDS.fontSizeMinimum} pixels.`,
  },
  'border-heavy': {
    title: 'Heavy borders',
    principle: `A border between a surface and its content reads at no more than ${GEOMETRY_THRESHOLDS.structuralBorderContrastMaximum}:1 against the surface outside it, and a control's border at no more than ${GEOMETRY_THRESHOLDS.controlBorderContrastMaximum}:1.`,
  },
  'border-thick': {
    title: 'Thick borders',
    principle: `A border is ${GEOMETRY_THRESHOLDS.borderWidthMaximum} pixel wide. Emphasis comes from color or fill, not thickness.`,
  },
  'border-mixed': {
    title: 'Inconsistent border weights',
    principle: `A page draws its structural borders in at most ${GEOMETRY_THRESHOLDS.structuralBorderWeightsMaximum} weights.`,
  },
} as const;

/** The name of a rule. */
export type GeometryRule = keyof typeof GEOMETRY_RULES;

/** One rule broken on one capture. */
export interface GeometryFinding {
  readonly rule: GeometryRule;
  /** What broke it, the same on every capture that shows the same defect. */
  readonly subject: string;
  /** The measured values, in words. */
  readonly measured: string;
  readonly capture: GeometryCapture;
}

/** One defect, with every capture that shows it. */
export interface ConsolidatedFinding {
  readonly rule: GeometryRule;
  readonly subject: string;
  /** The measured values on the first capture that showed it. */
  readonly measured: string;
  /** How many captures show it. */
  readonly captures: number;
  readonly widths: readonly number[];
  readonly routes: readonly string[];
  /** Up to five screenshots that show it, relative to the capture directory. */
  readonly examples: readonly string[];
}

/** How much of a capture directory the audit could read. */
export interface GeometryCoverage {
  /** The lines of the manifest. */
  readonly captures: number;
  /** The captures that carry measured facts. */
  readonly measured: number;
  /** The measured captures that emulated a coarse pointer. */
  readonly coarse: number;
  /** The measured captures whose page declared no spacing scale, so their gaps went unjudged. */
  readonly unscaled: number;
}

/** The stress seed's pathological text says nothing about labels or where content starts. */
const STRESS_SOURCE = 'responsive.spec.ts';

const EXAMPLES_MAXIMUM = 5;

/** Fewer steps than this is a scale the probe failed to read, not a scale. */
const SCALE_STEPS_MINIMUM = 3;

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** The empty room beside and above a control's content, or `null` when it draws none. */
function controlPadding(control: ControlFact): { inline: number; block: number } | null {
  const { rect, content } = control;
  if (content === null) return null;
  const before = content.x - rect.x;
  const after = rect.x + rect.width - (content.x + content.width);
  const above = content.y - rect.y;
  const below = rect.y + rect.height - (content.y + content.height);
  return { inline: Math.min(before, after), block: (above + below) / 2 };
}

function auditControls(facts: GeometryFacts, capture: GeometryCapture): GeometryFinding[] {
  const thresholds = GEOMETRY_THRESHOLDS;
  const phone = facts.viewport.width <= thresholds.phoneWidthMaximum;
  const stress = capture.source === STRESS_SOURCE;
  const findings: GeometryFinding[] = [];
  const add = (rule: GeometryRule, control: ControlFact, measured: string): void => {
    findings.push({ rule, subject: control.name, measured, capture });
  };
  for (const control of facts.controls) {
    const { rect } = control;
    const label = control.text === '' ? control.accessibleLabel : control.text;
    const padding = controlPadding(control);
    if (
      control.kind === 'button' &&
      control.boxed &&
      control.text !== '' &&
      !control.fullWidth &&
      padding !== null &&
      padding.block >= 1 &&
      padding.inline / padding.block < thresholds.buttonPaddingRatioMinimum
    ) {
      add(
        'button-padding-ratio',
        control,
        `"${label}": ${round(padding.inline)}px beside the label, ${round(padding.block)}px above and below (${round(padding.inline / padding.block)} to 1) in a ${round(rect.height)}px button`,
      );
    }
    if (phone && control.kind !== 'field' && !control.inline) {
      const singleLine = control.content !== null && control.content.height <= control.fontSize * 2;
      if (singleLine && rect.height > thresholds.phoneControlHeightMaximum) {
        add('target-oversized', control, `"${label}" is drawn ${round(rect.height)}px tall`);
      }
      if (
        control.kind === 'button' &&
        control.boxed &&
        control.text !== '' &&
        control.text.length <= thresholds.shortLabelCharacters &&
        rect.width >= facts.viewport.width * thresholds.stretchedButtonWidthShare
      ) {
        add(
          'button-stretched',
          control,
          `"${label}" spans ${round(rect.width)}px of a ${facts.viewport.width}px phone`,
        );
      }
      if (
        !stress &&
        control.kind === 'button' &&
        control.boxed &&
        control.labelRuns === 1 &&
        control.text.length > thresholds.shortLabelCharacters
      ) {
        add(
          'button-wordy',
          control,
          `"${label}" is ${control.text.length} characters and ${round(rect.width)}px wide`,
        );
      }
    }
    if (
      !control.inline &&
      !control.extendedHitArea &&
      Math.min(rect.width, rect.height) < thresholds.targetMinimum
    ) {
      add(
        'target-undersized',
        control,
        `"${label}" is ${round(rect.width)} by ${round(rect.height)}px with no extended hit area`,
      );
    }
  }
  return findings;
}

function auditType(facts: GeometryFacts, capture: GeometryCapture): GeometryFinding[] {
  const thresholds = GEOMETRY_THRESHOLDS;
  const findings: GeometryFinding[] = [];
  // Text set at no size is hidden on purpose, so it is not part of the page's type.
  const styles = facts.textStyles.filter((style) => style.fontSize >= 1);
  const sizes = [...new Set(styles.map((style) => style.fontSize))].toSorted(
    (left, right) => left - right,
  );
  if (sizes.length > thresholds.fontSizesMaximum) {
    findings.push({
      rule: 'type-sizes',
      subject: 'page type scale',
      measured: `${sizes.length} sizes: ${sizes.map((size) => `${round(size)}px`).join(', ')}`,
      capture,
    });
  }
  const lineHeightsBySize = new Map<number, Set<number>>();
  for (const style of styles) {
    if (!style.multiline || style.lineHeight === null) continue;
    const heights = lineHeightsBySize.get(style.fontSize) ?? new Set<number>();
    heights.add(round(style.lineHeight));
    lineHeightsBySize.set(style.fontSize, heights);
    if (style.fontSize > thresholds.bodyFontSizeMaximum) continue;
    const ratio = Math.round((style.lineHeight / style.fontSize) * 100) / 100;
    if (ratio < thresholds.lineHeightRatioMinimum || ratio > thresholds.lineHeightRatioMaximum) {
      findings.push({
        rule: 'line-height',
        subject: `${round(style.fontSize)}px text at ${round(style.lineHeight)}px line height`,
        measured: `${round(ratio)} times its size, as in "${style.sample}"`,
        capture,
      });
    }
  }
  for (const [fontSize, heights] of lineHeightsBySize) {
    if (heights.size <= thresholds.lineHeightsPerSizeMaximum) continue;
    const listed = [...heights].toSorted((left, right) => left - right);
    findings.push({
      rule: 'line-height-mixed',
      subject: `${round(fontSize)}px text`,
      measured: `line heights of ${listed.map((height) => `${height}px`).join(', ')}`,
      capture,
    });
  }
  for (const style of styles) {
    if (style.fontSize >= thresholds.fontSizeMinimum) continue;
    findings.push({
      rule: 'text-tiny',
      subject: `${round(style.fontSize)}px text`,
      measured: `as in "${style.sample}"`,
      capture,
    });
  }
  return findings;
}

function auditBorders(facts: GeometryFacts, capture: GeometryCapture): GeometryFinding[] {
  const thresholds = GEOMETRY_THRESHOLDS;
  const findings: GeometryFinding[] = [];
  const structuralWeights = new Set<number>();
  for (const border of facts.borders) {
    const limit = border.interactive
      ? thresholds.controlBorderContrastMaximum
      : thresholds.structuralBorderContrastMaximum;
    if (!border.interactive) structuralWeights.add(round(border.contrast));
    if (border.contrast > limit) {
      findings.push({
        rule: 'border-heavy',
        subject: border.name,
        measured: `${round(border.contrast)}:1 against the surface outside it, over the ${limit}:1 limit for a ${border.interactive ? 'control' : 'structural'} border`,
        capture,
      });
    }
    if (border.width > thresholds.borderWidthMaximum) {
      findings.push({
        rule: 'border-thick',
        subject: border.name,
        measured: `${round(border.width)}px wide`,
        capture,
      });
    }
  }
  if (structuralWeights.size > thresholds.structuralBorderWeightsMaximum) {
    const listed = [...structuralWeights].toSorted((left, right) => left - right);
    findings.push({
      rule: 'border-mixed',
      subject: 'structural borders',
      measured: `${listed.length} weights: ${listed.map((weight) => `${weight}:1`).join(', ')}`,
      capture,
    });
  }
  return findings;
}

function auditEdges(facts: GeometryFacts, capture: GeometryCapture): GeometryFinding[] {
  const thresholds = GEOMETRY_THRESHOLDS;
  const findings: GeometryFinding[] = [];
  const edges = facts.edges
    .filter((edge) => edge.count >= 2)
    .toSorted((left, right) => left.x - right.x);
  for (const [index, edge] of edges.entries()) {
    const next = edges[index + 1];
    if (next === undefined) continue;
    const distance = next.x - edge.x;
    if (distance <= thresholds.edgeAlignedWithin || distance > thresholds.edgeNearMissWithin) {
      continue;
    }
    findings.push({
      rule: 'edge-near-miss',
      subject: `${edge.samples[0] ?? 'content'} and ${next.samples[0] ?? 'content'}`,
      measured: `left edges at ${round(edge.x)}px (${edge.count} elements) and ${round(next.x)}px (${next.count} elements), ${round(distance)}px apart`,
      capture,
    });
  }
  return findings;
}

function auditStacks(facts: GeometryFacts, capture: GeometryCapture): GeometryFinding[] {
  const findings: GeometryFinding[] = [];
  const onScale = (gap: number): boolean =>
    gap <= 0.5 ||
    gap > GEOMETRY_THRESHOLDS.gapSlackAbove ||
    facts.spaceScale.some((step) => Math.abs(step - gap) <= 0.5);
  for (const stack of facts.stacks) {
    const distinct = [...new Set(stack.gaps.map((gap) => round(gap)))].toSorted(
      (left, right) => left - right,
    );
    for (const gap of distinct) {
      if (facts.spaceScale.length < SCALE_STEPS_MINIMUM || onScale(gap)) continue;
      findings.push({
        rule: 'gap-off-scale',
        subject: `${stack.name} at ${gap}px`,
        measured: `a ${gap}px gap between its children, among gaps of ${distinct.map((value) => `${value}px`).join(', ')}`,
        capture,
      });
    }
    const first = distinct[0];
    const last = distinct.at(-1);
    if (stack.uniformChildren && first !== undefined && last !== undefined && last - first >= 1) {
      findings.push({
        rule: 'gap-uneven',
        subject: stack.name,
        measured: `like children spaced ${distinct.map((value) => `${value}px`).join(', ')} apart`,
        capture,
      });
    }
  }
  return findings;
}

function auditLeadingSpace(facts: GeometryFacts, capture: GeometryCapture): GeometryFinding[] {
  const thresholds = GEOMETRY_THRESHOLDS;
  if (capture.source === STRESS_SOURCE) return [];
  const findings: GeometryFinding[] = [];
  // A row inside a row that already broke the rule is the same empty space, reported once.
  const broken = new Set<number>();
  for (const [index, row] of facts.leadingSpace.entries()) {
    if (row.within !== null && broken.has(row.within)) {
      broken.add(index);
      continue;
    }
    if (
      row.width <= 0 ||
      row.leading < thresholds.leadingSpaceMinimum ||
      row.leading < row.width * thresholds.leadingSpaceShare ||
      row.leading - row.trailing < row.width * thresholds.leadingSpaceImbalanceShare
    ) {
      continue;
    }
    broken.add(index);
    findings.push({
      rule: 'leading-space',
      subject: row.name,
      measured: `content ("${row.sample}") starts ${round(row.leading)}px in, ${Math.round((row.leading / row.width) * 100)}% of a ${round(row.width)}px row, with ${round(row.trailing)}px after it`,
      capture,
    });
  }
  return findings;
}

/** Holds one capture's measured facts to every rule. */
export function auditCapture(facts: GeometryFacts, capture: GeometryCapture): GeometryFinding[] {
  return [
    ...auditControls(facts, capture),
    ...auditType(facts, capture),
    ...auditBorders(facts, capture),
    ...auditEdges(facts, capture),
    ...auditStacks(facts, capture),
    ...auditLeadingSpace(facts, capture),
  ];
}

/** Folds findings that share a rule and a subject, ordered by rule and then by how widespread each is. */
export function consolidateFindings(findings: readonly GeometryFinding[]): ConsolidatedFinding[] {
  const groups = new Map<string, GeometryFinding[]>();
  for (const finding of findings) {
    const key = `${finding.rule}\n${finding.subject}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [finding]);
    else group.push(finding);
  }
  const order = Object.keys(GEOMETRY_RULES);
  return [...groups.values()]
    .map((group): ConsolidatedFinding => {
      const [first] = group as [GeometryFinding, ...GeometryFinding[]];
      const screenshots = [...new Set(group.map((finding) => finding.capture.viewport))];
      return {
        rule: first.rule,
        subject: first.subject,
        measured: first.measured,
        captures: screenshots.length,
        widths: [...new Set(group.map((finding) => finding.capture.width))].toSorted(
          (left, right) => left - right,
        ),
        routes: [...new Set(group.map((finding) => finding.capture.route))].toSorted(),
        examples: screenshots.slice(0, EXAMPLES_MAXIMUM),
      };
    })
    .toSorted(
      (left, right) =>
        order.indexOf(left.rule) - order.indexOf(right.rule) ||
        right.captures - left.captures ||
        left.subject.localeCompare(right.subject),
    );
}

/** A table cell cannot hold a pipe or a line break. */
function cell(text: string): string {
  return text.replaceAll('|', '/').replaceAll(/\s+/g, ' ');
}

/** The Markdown report a reviewer reads beside the screenshots. */
export function renderGeometryReport(
  findings: readonly ConsolidatedFinding[],
  coverage: GeometryCoverage,
): string {
  const lines = [
    '# Geometry audit',
    '',
    `Measured ${coverage.measured} of ${coverage.captures} captures. Each line is a measured fact held to a threshold in \`references/rubric.md\` "Craft", not a verdict: confirm it on a screenshot it names before reporting it, and route it Cinder first.`,
    '',
  ];
  if (coverage.measured > 0 && coverage.coarse === 0) {
    lines.push(
      'No capture emulated a coarse pointer, so styles under `@media (pointer: coarse)` (touch-sized rows, extended hit areas) did not apply: the phone widths show the mouse layout at a narrow width.',
      '',
    );
  }
  if (coverage.unscaled > 0) {
    lines.push(
      `${coverage.unscaled} measured captures declared no \`--cinder-space-*\` scale the probe could read, so the gaps on them were not held to it.`,
      '',
    );
  }
  if (findings.length === 0) lines.push('No findings.', '');
  for (const [rule, { title, principle }] of Object.entries(GEOMETRY_RULES)) {
    const found = findings.filter((finding) => finding.rule === rule);
    if (found.length === 0) continue;
    lines.push(`## ${title}`, '', principle, '');
    lines.push('| Subject | Measured | Captures | Widths | Routes | Examples |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const finding of found) {
      const routes =
        finding.routes.length > 4
          ? `${finding.routes.slice(0, 4).join(', ')} and ${finding.routes.length - 4} more`
          : finding.routes.join(', ');
      lines.push(
        `| ${cell(finding.subject)} | ${cell(finding.measured)} | ${finding.captures} | ${finding.widths.join(', ')} | ${cell(routes)} | ${finding.examples.map((example) => `\`${example}\``).join(' ')} |`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

async function readManifest(directory: string): Promise<GeometryCapture[]> {
  let text: string;
  try {
    text = await readFile(join(directory, 'manifest.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as GeometryCapture);
}

/** Audits a capture directory and writes its two reports; answers what it read and found. */
export async function auditGeometry(
  directory: string,
): Promise<GeometryCoverage & { readonly findings: number }> {
  const captures = await readManifest(directory);
  const findings: GeometryFinding[] = [];
  let measured = 0;
  let coarse = 0;
  let unscaled = 0;
  for (const capture of captures) {
    if (capture.geometry === undefined) continue;
    const facts = JSON.parse(
      await readFile(join(directory, capture.geometry), 'utf8'),
    ) as GeometryFacts;
    measured += 1;
    if (facts.pointerCoarse) coarse += 1;
    if (facts.spaceScale.length < SCALE_STEPS_MINIMUM) unscaled += 1;
    findings.push(...auditCapture(facts, capture));
  }
  const coverage: GeometryCoverage = { captures: captures.length, measured, coarse, unscaled };
  if (measured === 0) return { ...coverage, findings: 0 };
  const consolidated = consolidateFindings(findings);
  await writeFile(
    join(directory, 'geometry-findings.json'),
    `${JSON.stringify({ coverage, thresholds: GEOMETRY_THRESHOLDS, findings: consolidated }, null, 2)}\n`,
  );
  await writeFile(
    join(directory, 'geometry-report.md'),
    renderGeometryReport(consolidated, coverage),
  );
  return { ...coverage, findings: consolidated.length };
}

/** Runs the command line and answers the exit code. */
export async function runGeometryAudit(
  argv: readonly string[] = process.argv.slice(2),
  write: { out: (text: string) => void; error: (text: string) => void } = {
    out: (text) => void process.stdout.write(text),
    error: (text) => void process.stderr.write(text),
  },
): Promise<number> {
  const [flag, value, ...rest] = argv;
  if (flag !== '--capture' || value === undefined || rest.length > 0) {
    write.error('usage: bun scripts/design-review-geometry.ts --capture <capture directory>\n');
    return 2;
  }
  const directory = resolve(value);
  const result = await auditGeometry(directory);
  if (result.measured === 0) {
    write.error(`design review: no measured capture in ${directory}\n`);
    return 1;
  }
  write.out(
    `design review: ${result.findings} geometry findings from ${result.measured} measured captures: ${join(directory, 'geometry-report.md')}\n`,
  );
  return 0;
}

if (import.meta.main) process.exitCode = await runGeometryAudit();
