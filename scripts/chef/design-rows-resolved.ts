// The format and validator of `rows.resolved.json`, the file a pre-build design critique writes
// before an issue with design rows is built (`tmp/chef/briefs/<ID>/rows.resolved.json` in the main
// checkout). The 2026-11-19 review found five rows that conflicted with each other or with the
// issue's own literal criteria (COR-2444's 700px threshold), discovered only after building, and
// about 30 defects on screens whose states were never captured. The file makes both a precondition:
//
//   - every row declares the states it covers, each as a route and the state name its capture
//     specification writes into `manifest.jsonl`, with a kind so first-run and empty states are
//     first-class (`applications/interborough/scripts/design-review-rows.ts` turns the rows into a
//     capture manifest, widest width first);
//   - every literal pixel threshold in the issue's text is checked against the rows, and each conflict
//     is settled as a decision or a deferral with a reason, never left open.
//
// This module is a library with no command line: `brief.ts` calls it to refuse a brief, and
// `design-critique.ts` calls it to refuse a malformed critique.

import { join } from 'node:path';

export const RESOLVED_VERSION = 2 as const;

/**
 * The widths a row is captured at when it names none, each from the specs that capture it:
 * 1920 because the owner works at about 1,950px (`chef/capture-1920`, COR-2445, repeats every 1280
 * capture there, so plans refuse until it lands); 1280 and 375 because every state spec captures
 * them (`15-view-states.spec.ts` WIDTHS, `first-run.spec.ts`). 768 is not a default: only the
 * showcase specs (`00-showcase.spec.ts` WIDTHS, ready states with data) capture it, so a row that
 * declares a ready state at 768 names its `widths` itself.
 */
export const DEFAULT_WIDTHS: readonly number[] = [1920, 1280, 375];

/** The themes a row is captured in when it names none. */
export const DEFAULT_THEMES: readonly ('light' | 'dark')[] = ['light', 'dark'];

/** The widest a phone is: a row's widths hold at least one at or under it. */
export const PHONE_WIDTH_MAXIMUM = 480;

/** First-run and empty are kinds of their own, so a row cannot cover them by accident. */
export const STATE_KINDS = [
  'ready',
  'loading',
  'empty',
  'first-run',
  'error',
  'forbidden',
  'other',
] as const;

export type StateKind = (typeof STATE_KINDS)[number];

/** One named physical viewport a state must prove before its broad review can begin. */
export interface ViewportWitnessProfile {
  readonly name: string;
  readonly width: number;
  readonly theme: 'light' | 'dark';
  /** Stable `data-testid` values or `role:<role>:<exact accessible name>` descriptors. */
  readonly targets: readonly string[];
  /** What a reviewer should see in the viewport image. */
  readonly visible: string;
  /** Whether the test intentionally scrolls the outlet before proving its targets. */
  readonly scrolling: 'none' | 'outlet';
}

/** The exact Playwright state that produces a row's narrow physical witness. */
interface ViewportWitness {
  /**
   * Repository-relative Playwright specification under Interborough's end-to-end or panel tests,
   * for example `applications/interborough/tests/e2e/runs-states.spec.ts`.
   */
  readonly specification: string;
  /**
   * The full, literal, project-qualified title Playwright matches `--grep` against: the project,
   * the file relative to `tests/`, and the title path, joined by spaces, as `bun --bun playwright
   * test --list` names it, for example `chromium e2e/runs-states.spec.ts /runs ready at 375 pixels`.
   * It is escaped and anchored, never evaluated, and must select exactly one test.
   */
  readonly title: string;
  /** Fixture world recorded by the capture manifest. */
  readonly world: string;
  readonly profiles: readonly ViewportWitnessProfile[];
}

/** One capture a row needs: the route pattern and the state name the capture writes. */
export interface ResolvedState {
  readonly route: string;
  readonly state: string;
  readonly kind: StateKind;
  readonly witness: ViewportWitness;
}

export interface ResolvedRow {
  readonly id: string;
  readonly board: string;
  readonly text: string;
  readonly states: readonly ResolvedState[];
  readonly widths?: readonly number[];
  readonly themes?: readonly ('light' | 'dark')[];
}

export interface ResolvedCheck {
  readonly literal: string;
  readonly result: 'consistent' | 'conflict';
}

export interface ResolvedConflict {
  readonly criterion: string;
  readonly rows: readonly string[];
  readonly resolution: 'decision' | 'deferral';
  readonly reason: string;
}

export interface ResolvedRows {
  readonly version: typeof RESOLVED_VERSION;
  readonly issue: string;
  readonly rows: readonly ResolvedRow[];
  readonly checked: readonly ResolvedCheck[];
  readonly conflicts: readonly ResolvedConflict[];
}

/** What a file is held to: the issue it is for, its design rows and its literal criteria. */
export interface ResolvedExpectation {
  readonly issue: string;
  readonly rowIds: readonly string[];
  readonly literals: readonly string[];
}

/** Where an issue's resolved file lives under the briefs directory. */
export function resolvedPath(briefsDirectory: string, issue: string): string {
  return join(briefsDirectory, issue, 'rows.resolved.json');
}

/** The literal pixel thresholds an issue's text states, normalised (`700 px` is `700px`), once each. */
export function literalCriteria(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?<![\w.])(\d{2,5})\s?px\b/gi)) found.add(`${match[1]}px`);
  return [...found];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function widthProblems(id: string, widths: unknown): string[] {
  if (!Array.isArray(widths) || widths.some((width) => !Number.isInteger(width) || width <= 0))
    return [`row ${id} widths must be a list of positive whole numbers`];
  const problems: string[] = [];
  const list = widths as number[];
  if (!list.includes(1920)) problems.push(`row ${id} widths lack 1920`);
  if (!list.includes(1280)) problems.push(`row ${id} widths lack 1280`);
  if (!list.some((width) => width <= PHONE_WIDTH_MAXIMUM))
    problems.push(`row ${id} widths lack a phone width (at most ${PHONE_WIDTH_MAXIMUM})`);
  return problems;
}

function stateProblems(id: string, states: unknown): string[] {
  if (!Array.isArray(states) || states.length === 0) return [`row ${id} declares no states`];
  const problems: string[] = [];
  for (const [index, entry] of states.entries()) {
    const state = record(entry);
    const label = `row ${id} state ${index + 1}`;
    if (state === undefined) problems.push(`${label} is not an object`);
    else {
      const route = state['route'];
      if (!nonEmpty(route) || !route.startsWith('/'))
        problems.push(`${label} needs a route that starts with /`);
      if (!nonEmpty(state['state'])) problems.push(`${label} needs a state name`);
      if (!(STATE_KINDS as readonly unknown[]).includes(state['kind']))
        problems.push(`${label} kind must be one of ${STATE_KINDS.join(', ')}`);
      problems.push(...witnessProblems(label, state['witness']));
    }
  }
  return problems;
}

/**
 * The fixture worlds a capture records, from the host the page was served by (`designReviewWorld`
 * in `applications/interborough/tests/e2e/design-review-capture.ts`).
 */
export const WITNESS_WORLDS = [
  'sample-world',
  'first-run',
  'plugin-pages',
  'stress',
  'e2e-host',
] as const;

/** The directory Playwright runs from; a witness's specification is passed relative to it. */
export const WITNESS_APPLICATION_DIRECTORY = 'applications/interborough/';

/** The repository-relative Playwright specifications a witness may name. */
export const WITNESS_SPECIFICATION =
  /^applications\/interborough\/tests\/(?:e2e|panels)\/[a-z0-9][a-z0-9-]*\.spec\.ts$/;

/** A `data-testid` value or a `role:<role>:<exact accessible name>` descriptor, matched as text. */
export function isWitnessTarget(target: unknown): target is string {
  return (
    typeof target === 'string' &&
    (/^[a-z][a-z0-9-]*$/.test(target) || /^role:[a-z-]+:[^:\n]+$/.test(target))
  );
}

function witnessProblems(label: string, value: unknown): string[] {
  const witness = record(value);
  if (witness === undefined) return [`${label} needs a viewport witness`];
  const problems: string[] = [];
  const specification = witness['specification'];
  if (!nonEmpty(specification) || !WITNESS_SPECIFICATION.test(specification))
    problems.push(`${label} witness needs a repository-relative Playwright specification`);
  if (!nonEmpty(witness['title']) || witness['title'].includes('\n'))
    problems.push(`${label} witness needs one literal full title`);
  if (!(WITNESS_WORLDS as readonly unknown[]).includes(witness['world']))
    problems.push(`${label} witness world must be one of ${WITNESS_WORLDS.join(', ')}`);
  const profiles = witness['profiles'];
  if (!Array.isArray(profiles) || profiles.length === 0) {
    problems.push(`${label} witness needs at least one viewport profile`);
    return problems;
  }
  const names = new Set<string>();
  const viewports = new Set<string>();
  for (const [index, entry] of profiles.entries()) {
    const profile = record(entry);
    const profileLabel = `${label} witness profile ${index + 1}`;
    if (profile === undefined) {
      problems.push(`${profileLabel} is not an object`);
      continue;
    }
    const name = profile['name'];
    if (!nonEmpty(name) || !/^[a-z][a-z0-9-]*$/.test(name))
      problems.push(`${profileLabel} needs a kebab-case name`);
    else if (names.has(name)) problems.push(`${label} witness profile ${name} appears twice`);
    else names.add(name);
    const width = profile['width'];
    if (!Number.isInteger(width) || typeof width !== 'number' || width <= 0)
      problems.push(`${profileLabel} needs a positive whole width`);
    const theme = profile['theme'];
    if (theme !== 'light' && theme !== 'dark')
      problems.push(`${profileLabel} theme must be light or dark`);
    else if (typeof width === 'number' && Number.isInteger(width)) {
      const key = `${width}|${theme}`;
      if (viewports.has(key)) problems.push(`${label} witness repeats viewport ${key}`);
      else viewports.add(key);
    }
    const targets = profile['targets'];
    if (!Array.isArray(targets) || targets.length === 0 || !targets.every(isWitnessTarget))
      problems.push(`${profileLabel} needs named data-testid or role targets`);
    if (!nonEmpty(profile['visible'])) problems.push(`${profileLabel} needs a visible expectation`);
    if (profile['scrolling'] !== 'none' && profile['scrolling'] !== 'outlet')
      problems.push(`${profileLabel} scrolling must be none or outlet`);
  }
  return problems;
}

function rowProblems(value: unknown, expected: ResolvedExpectation): string[] {
  const entries = Array.isArray(value) ? value : [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const row = record(entry);
    const id = row?.['id'];
    if (row === undefined || !nonEmpty(id)) {
      problems.push('a row has no id');
      continue;
    }
    if (seen.has(id)) problems.push(`row ${id} appears twice`);
    seen.add(id);
    if (!expected.rowIds.includes(id)) problems.push(`row ${id} is not a row of ${expected.issue}`);
    if (!nonEmpty(row['board'])) problems.push(`row ${id} needs a board`);
    problems.push(...stateProblems(id, row['states']));
    if (row['widths'] !== undefined) problems.push(...widthProblems(id, row['widths']));
    const themes = row['themes'];
    if (
      themes !== undefined &&
      (!Array.isArray(themes) ||
        themes.length === 0 ||
        themes.some((t) => t !== 'light' && t !== 'dark'))
    )
      problems.push(`row ${id} themes must be light, dark or both`);
  }
  for (const id of expected.rowIds)
    if (!seen.has(id)) problems.push(`row ${id} has no entry; declare its states`);
  return problems;
}

function conflictProblems(value: unknown, expected: ResolvedExpectation): string[] {
  const problems: string[] = [];
  const conflicts = Array.isArray(value) ? value : [];
  for (const [index, entry] of conflicts.entries()) {
    const conflict = record(entry);
    const label = `conflict ${index + 1}`;
    if (conflict === undefined) problems.push(`${label} is not an object`);
    else {
      if (!nonEmpty(conflict['criterion'])) problems.push(`${label} needs the criterion`);
      if (conflict['resolution'] !== 'decision' && conflict['resolution'] !== 'deferral')
        problems.push(`${label} resolution must be decision or deferral`);
      if (!nonEmpty(conflict['reason'])) problems.push(`${label} needs a reason`);
      const rows = conflict['rows'];
      if (
        !Array.isArray(rows) ||
        rows.length === 0 ||
        rows.some((row) => typeof row !== 'string' || !expected.rowIds.includes(row))
      )
        problems.push(`${label} must name the design rows it settles`);
    }
  }
  return problems;
}

function checkProblems(
  value: unknown,
  conflicts: unknown,
  expected: ResolvedExpectation,
): string[] {
  const checked = (Array.isArray(value) ? value : []).map(record);
  const problems: string[] = [];
  const criteria = (Array.isArray(conflicts) ? conflicts : []).map((conflict) => {
    const criterion = record(conflict)?.['criterion'];
    return typeof criterion === 'string' ? criterion : '';
  });
  for (const literal of expected.literals) {
    const entry = checked.find((candidate) => candidate?.['literal'] === literal);
    if (entry === undefined) problems.push(`literal criterion ${literal} was not checked`);
    else if (entry['result'] !== 'consistent' && entry['result'] !== 'conflict')
      problems.push(`literal criterion ${literal} result must be consistent or conflict`);
    else if (
      entry['result'] === 'conflict' &&
      !criteria.some((criterion) => criterion.replaceAll(/\s/g, '').includes(literal))
    )
      problems.push(`literal criterion ${literal} conflicts with a row but no conflict records it`);
  }
  return problems;
}

/** What is wrong with a parsed `rows.resolved.json`, one line each; empty when it is sound. */
export function validateResolved(value: unknown, expected: ResolvedExpectation): string[] {
  const file = record(value);
  if (file === undefined) return ['rows.resolved.json is not an object'];
  const problems: string[] = [];
  if (file['version'] !== RESOLVED_VERSION)
    problems.push(`rows.resolved.json version must be ${RESOLVED_VERSION}`);
  if (file['issue'] !== expected.issue)
    problems.push(`rows.resolved.json is for ${String(file['issue'])}, not ${expected.issue}`);
  problems.push(
    ...rowProblems(file['rows'], expected),
    ...conflictProblems(file['conflicts'], expected),
    ...checkProblems(file['checked'], file['conflicts'], expected),
  );
  return problems;
}
