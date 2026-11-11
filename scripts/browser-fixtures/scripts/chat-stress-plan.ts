/**
 * What the Chat stress capture (`capture-chat-stress.ts`, COR-2289) promises, as pure functions that the
 * tool and its tests share: the four profiles, the image names, how many images a run must hold,
 * what a page measurement must show, whether the manifest, the files and the gallery agree, and the
 * gallery itself. Nothing here starts a browser or a process, so `chat-stress-plan.test.ts` runs in
 * the default lane.
 */
import { createHash } from 'node:crypto';

import { caseLabel, type StressCase } from '../src/fixtures/chat-stress/stress-cases.ts';

/** One viewport, theme and input mode a case is drawn at. */
export interface StressProfile {
  /** The width and theme in the image name, such as `1440-light`. */
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly theme: 'light' | 'dark';
  /** Whether the profile has a touch screen and a coarse pointer, as every width below 500 does. */
  readonly coarse: boolean;
}

/** The four profiles of the board: 1440 light, 768 dark, 390 light and 320 dark. */
export const STRESS_PROFILES: readonly StressProfile[] = [
  { name: '1440-light', width: 1440, height: 900, theme: 'light', coarse: false },
  { name: '768-dark', width: 768, height: 1024, theme: 'dark', coarse: false },
  { name: '390-light', width: 390, height: 844, theme: 'light', coarse: true },
  { name: '320-dark', width: 320, height: 640, theme: 'dark', coarse: true },
];

/** The extra phone profile `CHAT_STRESS_SUPPLEMENTAL=1` adds, for the header and safe-area frames. */
export const SUPPLEMENTAL_PROFILE: StressProfile = {
  name: '390-dark',
  width: 390,
  height: 844,
  theme: 'dark',
  coarse: true,
};

/** The profiles a run draws each case at. */
export function profilesFor(supplemental: boolean): readonly StressProfile[] {
  return supplemental ? [...STRESS_PROFILES, SUPPLEMENTAL_PROFILE] : STRESS_PROFILES;
}

/** The smallest a touch target may be, in CSS pixels, in both dimensions. */
export const MINIMUM_TOUCH_TARGET = 44;

/** The most the composer's bottom edge may differ between two cases that must share it, in CSS pixels. */
export const COMPOSER_EDGE_TOLERANCE = 0.5;

/** The prefix of a run's output directory; the tool appends a unique suffix so no run overwrites another. */
export const RUN_DIRECTORY_PREFIX = 'real-chat-captures-';

/** The name of a case's primary image: `<width>-<theme>-<case>.png`. */
export function primaryImageName(profile: StressProfile, caseId: number): string {
  return `${profile.name}-${caseLabel(caseId)}.png`;
}

/** The name of a variant image: `<width>-<theme>-<case>-<variant>.png`. */
export function variantImageName(profile: StressProfile, caseId: number, variant: string): string {
  return `${profile.name}-${caseLabel(caseId)}-${variant}.png`;
}

/** The variant name of the stop at this position (counted from one) in a case's focus sweep. */
export function focusVariantName(index: number): string {
  return `focus-${index}`;
}

/** One control a focus sweep stopped on. */
export interface FocusStop {
  /** The position in the tab order, counted from one. */
  readonly index: number;
  /** The control's accessible name as the page reports it. */
  readonly name: string;
}

/** What a run holds for one image, written one per line to `manifest.jsonl`. */
export interface CaptureRecord {
  readonly caseId: number;
  readonly profile: string;
  readonly kind: 'primary' | 'variant' | 'focus';
  /** The variant name, for a variant or a focus stop. */
  readonly variant?: string;
  readonly file: string;
  /** The control a focus image shows. */
  readonly focus?: FocusStop;
  /** What went wrong with the page at this image; empty for a clean one. */
  readonly problems: readonly string[];
  /** Why the case cannot prove its row here, when it is deferred. */
  readonly deferred?: string;
}

/** How many images of each kind a run must hold. */
export interface ExpectedCounts {
  readonly primary: number;
  readonly fixedVariants: number;
  readonly focus: number;
  readonly total: number;
}

/**
 * The image counts a complete run holds: one primary per case and profile, every case's fixed
 * variants at every profile, and the focus stops each profile's sweep found. The focus counts come
 * from the run, because a control count is a fact of the page.
 */
export function expectedCounts(
  cases: readonly StressCase[],
  profiles: readonly StressProfile[],
  focusStopsByProfile: Readonly<Record<string, number>>,
): ExpectedCounts {
  const primary = cases.length * profiles.length;
  const fixedVariants =
    cases.reduce((sum, stressCase) => sum + stressCase.variants.length, 0) * profiles.length;
  const focus = profiles.reduce(
    (sum, profile) =>
      sum +
      (Object.hasOwn(focusStopsByProfile, profile.name)
        ? (focusStopsByProfile[profile.name] ?? 0)
        : 0),
    0,
  );
  return { primary, fixedVariants, focus, total: primary + fixedVariants + focus };
}

/** What a page reports about itself once a case has run, collected in the page by the tool. */
export interface PageMeasurement {
  /** Console errors and uncaught page errors since the page loaded. */
  readonly pageErrors: readonly string[];
  /** The document's scroll width and the window's width. */
  readonly documentWidth: { readonly scroll: number; readonly client: number };
  /** Visible, enabled controls under 44 px in either dimension, named; measured only at a coarse profile. */
  readonly smallTargets: readonly {
    readonly name: string;
    readonly width: number;
    readonly height: number;
  }[];
  /** Status text whose box clips it. */
  readonly clippedStatuses: readonly string[];
  /** The resolved direction and alignment of the text blocks a right-to-left case shows. */
  readonly directions: readonly {
    readonly text: string;
    readonly direction: string;
    readonly textAlign: string;
  }[];
  /** The composer's bottom edge in CSS pixels, or `null` when no composer is drawn. */
  readonly composerEdge: number | null;
  /** For a withdrawal case: how many announcements followed and whether the focused control shows a ring. */
  readonly withdrawal?: { readonly announcements: number; readonly focusVisible: boolean };
}

/** Everything wrong with one page's measurement; an empty list means it passed. */
export function measurementProblems(
  measurement: PageMeasurement,
  profile: StressProfile,
  stressCase: StressCase,
): string[] {
  const problems: string[] = [];
  for (const error of measurement.pageErrors) problems.push(`page error: ${error}`);
  if (measurement.documentWidth.scroll > measurement.documentWidth.client) {
    problems.push(
      `document overflow: ${measurement.documentWidth.scroll} px of content in ${measurement.documentWidth.client} px`,
    );
  }
  if (profile.coarse) {
    for (const target of measurement.smallTargets) {
      problems.push(
        `short touch target: ${target.name} is ${target.width} by ${target.height} px, under ${MINIMUM_TOUCH_TARGET}`,
      );
    }
  }
  for (const status of measurement.clippedStatuses) problems.push(`clipped status: ${status}`);
  if (stressCase.direction === 'rtl') {
    if (measurement.directions.length === 0) problems.push('no right-to-left text was measured');
    for (const block of measurement.directions) {
      const aligned = block.textAlign === 'start' || block.textAlign === 'right';
      if (block.direction !== 'rtl' || !aligned) {
        problems.push(
          `wrong direction: "${block.text}" is ${block.direction} aligned ${block.textAlign}`,
        );
      }
    }
  }
  if (stressCase.id === 45) {
    if (measurement.withdrawal === undefined) problems.push('no withdrawal was measured');
    else {
      if (measurement.withdrawal.announcements !== 1) {
        problems.push(
          `withdrawal made ${measurement.withdrawal.announcements} announcements, not one`,
        );
      }
      if (!measurement.withdrawal.focusVisible) problems.push('withdrawal left no visible focus');
    }
  }
  return problems;
}

/** The composer-edge pairs that differ at one profile; `edges` maps a case number to its edge. */
export function composerEdgeProblems(
  cases: readonly StressCase[],
  profile: StressProfile,
  edges: ReadonlyMap<number, number | null>,
): string[] {
  const problems: string[] = [];
  for (const stressCase of cases) {
    const partner = stressCase.composerEdgeWith;
    if (partner === undefined || partner < stressCase.id) continue;
    const first = edges.get(stressCase.id);
    const second = edges.get(partner);
    if (first === undefined || second === undefined) continue;
    if (first === null || second === null) {
      problems.push(
        `${profile.name}: composer edge missing in case ${caseLabel(first === null ? stressCase.id : partner)}`,
      );
    } else if (Math.abs(first - second) > COMPOSER_EDGE_TOLERANCE) {
      problems.push(
        `${profile.name}: composer edge moved from ${first} to ${second} between cases ${caseLabel(stressCase.id)} and ${caseLabel(partner)}`,
      );
    }
  }
  return problems;
}

/** Whether the files, the manifest and the gallery agree; `files` are the PNG names on disk. */
export function reconciliationProblems(
  records: readonly CaptureRecord[],
  files: readonly string[],
  galleryFiles: readonly string[],
): string[] {
  const problems: string[] = [];
  const named = new Set(records.map((record) => record.file));
  if (named.size !== records.length) problems.push('the manifest names an image twice');
  const onDisk = new Set(files);
  for (const file of named) {
    if (!onDisk.has(file)) problems.push(`the manifest names ${file}, which is not on disk`);
  }
  for (const file of onDisk) {
    if (!named.has(file)) problems.push(`${file} is on disk but not in the manifest`);
  }
  const shown = new Set(galleryFiles);
  for (const file of named) {
    if (!shown.has(file)) problems.push(`the gallery does not show ${file}`);
  }
  for (const record of records) {
    if (record.kind === 'focus' && (record.focus === undefined || record.focus.name === '')) {
      problems.push(`${record.file} is a focus image with no control name`);
    }
  }
  return problems;
}

/** Whether a run's counts are the counts it must hold, with the focus sweep nonzero where a case asks for one. */
export function countProblems(
  records: readonly CaptureRecord[],
  cases: readonly StressCase[],
  profiles: readonly StressProfile[],
): string[] {
  const problems: string[] = [];
  const focusStops: Record<string, number> = {};
  for (const record of records) {
    if (record.kind === 'focus') focusStops[record.profile] = (focusStops[record.profile] ?? 0) + 1;
  }
  const expected = expectedCounts(cases, profiles, focusStops);
  const actual = {
    primary: records.filter((record) => record.kind === 'primary').length,
    fixedVariants: records.filter((record) => record.kind === 'variant').length,
    focus: records.filter((record) => record.kind === 'focus').length,
  };
  if (actual.primary !== expected.primary) {
    problems.push(`expected ${expected.primary} primary images, found ${actual.primary}`);
  }
  if (actual.fixedVariants !== expected.fixedVariants) {
    problems.push(
      `expected ${expected.fixedVariants} fixed variant images, found ${actual.fixedVariants}`,
    );
  }
  if (cases.some((stressCase) => stressCase.focusSweep)) {
    for (const profile of profiles) {
      if ((focusStops[profile.name] ?? 0) === 0)
        problems.push(`${profile.name}: the focus sweep found no control`);
    }
  }
  return problems;
}

/** What identifies the source a run drew, written before the first case is captured. */
export interface SourceIdentity {
  /** The commit the working tree is based on. */
  readonly head: string;
  /** A digest of the uncommitted changes, so two runs of one commit with different edits differ. */
  readonly changesDigest: string;
  /** A digest of the built page the cases were served from. */
  readonly buildDigest: string;
  readonly bunVersion: string;
  /** One digest of all of the above. */
  readonly identity: string;
}

/** Combines what identifies a run's source into one identity. */
export function sourceIdentity(parts: Omit<SourceIdentity, 'identity'>): SourceIdentity {
  const identity = createHash('sha256')
    .update([parts.head, parts.changesDigest, parts.buildDigest, parts.bunVersion].join('\0'))
    .digest('hex');
  return { ...parts, identity };
}

/** What a run wrote as `summary.json`. */
export interface RunSummary {
  readonly passed: boolean;
  /** Whether the run drew all 80 cases at all four profiles; a selection of cases is a partial run. */
  readonly complete: boolean;
  readonly runDirectory: string;
  readonly identity: SourceIdentity;
  readonly cases: number;
  readonly profiles: readonly string[];
  readonly counts: {
    readonly primary: number;
    readonly fixedVariants: number;
    readonly focus: number;
    readonly total: number;
  };
  /** Cases that cannot prove their row in this fixture, with the reason. */
  readonly deferred: readonly { readonly caseId: number; readonly reason: string }[];
  /** Every problem found, each naming the case, the profile and the measurement. */
  readonly errors: readonly string[];
}

/**
 * The cases a `--cases` argument names: a comma list of numbers and ranges such as `9,10,14-15`, or
 * every case when it is omitted. Throws for a number that is not a case, so a typo never narrows a run.
 */
export function selectCases(
  cases: readonly StressCase[],
  selection: string | undefined,
): StressCase[] {
  if (selection === undefined || selection.trim() === '') return [...cases];
  const wanted = new Set<number>();
  for (const part of selection.split(',')) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (range === null) throw new Error(`'${part}' is not a case number or a range such as 14-15.`);
    const first = Number(range[1]);
    const last = range[2] === undefined ? first : Number(range[2]);
    for (let id = first; id <= last; id += 1) wanted.add(id);
  }
  const unknown = [...wanted].filter((id) => !cases.some((stressCase) => stressCase.id === id));
  if (unknown.length > 0) throw new Error(`Unknown case numbers: ${unknown.join(', ')}.`);
  return cases.filter((stressCase) => wanted.has(stressCase.id));
}

/** Escapes text for HTML. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The gallery: every image of the run grouped by case, each with the problems found at it. A run
 * that failed says so at the top and lists every error, so a gallery never reads as a pass it did
 * not earn; a deferred case says it proves nothing here.
 */
export function renderGallery(
  records: readonly CaptureRecord[],
  cases: readonly StressCase[],
  summary: RunSummary,
): string {
  const sections = cases.map((stressCase) => {
    const own = records.filter((record) => record.caseId === stressCase.id);
    const figures = own
      .map((record) => {
        const caption =
          record.kind === 'primary'
            ? record.profile
            : `${record.profile} ${record.variant ?? ''}`.trim();
        const focus = record.focus === undefined ? '' : ` (${escapeHtml(record.focus.name)})`;
        const problems = record.problems
          .map((problem) => `<li>${escapeHtml(problem)}</li>`)
          .join('');
        const state = record.problems.length === 0 ? 'clean' : 'failed';
        return `<figure class="${state}"><img src="${escapeHtml(record.file)}" alt="${escapeHtml(`Case ${caseLabel(stressCase.id)} ${caption}`)}" loading="lazy"><figcaption>${escapeHtml(caption)}${focus}</figcaption>${problems === '' ? '' : `<ul>${problems}</ul>`}</figure>`;
      })
      .join('\n');
    const deferred =
      stressCase.deferred === undefined
        ? ''
        : `<p class="deferred">Deferred: ${escapeHtml(stressCase.deferred)}</p>`;
    return `<section id="case-${caseLabel(stressCase.id)}"><h2>${caseLabel(stressCase.id)} ${escapeHtml(stressCase.slug)}</h2><p>${escapeHtml(stressCase.title)} Rows ${escapeHtml(stressCase.rows.join(', '))}. ${escapeHtml(stressCase.provenance)}.</p>${deferred}<div class="grid">${figures}</div></section>`;
  });
  const status = summary.passed ? 'Passed' : 'Failed';
  const partial = summary.complete ? '' : ' (partial run)';
  const errors = summary.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat stress gallery</title>
<style>
body { font: 14px/1.4 system-ui, sans-serif; margin: 1rem; }
.failed { outline: 2px solid #b42318; }
.deferred { color: #8a4b00; }
.grid { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: flex-start; }
figure { margin: 0; max-width: 24rem; }
img { max-width: 100%; border: 1px solid #ccc; }
</style>
</head>
<body>
<h1>Chat stress gallery: ${status}${partial}</h1>
<p>${summary.counts.primary} primary images, ${summary.counts.fixedVariants} fixed variants, ${summary.counts.focus} focus images (${summary.counts.total} in all) at ${escapeHtml(summary.profiles.join(', '))}. Source identity ${escapeHtml(summary.identity.identity)}.</p>
${errors === '' ? '' : `<h2>Errors</h2><ul>${errors}</ul>`}
${sections.join('\n')}
</body>
</html>
`;
}

/** The file names a gallery's images reference, read back from its HTML. */
export function galleryImageFiles(html: string): string[] {
  return [...html.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1] ?? '');
}
