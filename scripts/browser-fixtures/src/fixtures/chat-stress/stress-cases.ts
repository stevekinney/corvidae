/**
 * The 80 Chat stress cases (COR-2289) as data: which scenario each case builds, which design rows it
 * proves, and the real component flow the capture tool drives before it screenshots. The cases
 * live in `../chat-stress.json`; this module types and validates them and imports nothing from
 * Chat, so the capture tool and its tests read the same list the fixture serves.
 *
 * The original 80 definitions were lost. Cases the board issues name are marked `issue-named` and
 * carry the sentence that names them in `source`; every other case is `derived` from the design row
 * it proves, and its number is a placeholder that keeps the numbered slots the issues rely on.
 */

/** Where a case's definition comes from. */
export type StressProvenance = 'issue-named' | 'derived';

/**
 * One real interaction on the page, driven by the capture tool through Playwright. A step that
 * cannot find its control fails the case at the shared deadline, so a case never passes by showing
 * an end state the flow did not reach.
 *
 * - `click`, `fill` and `focus` find a control by its ARIA role and a substring of its accessible name.
 * - `press` sends a key to the focused element (a real key press, not an event dispatch).
 * - `hook` calls a host operation the fixture exposes on `window.corvidaeChatStress`, for what only
 *   the host does: a dropped connection, a token arriving, a decision made in another surface.
 * - `expect` waits for a control or text to be visible, which proves the flow reached its state.
 * - `upload` chooses files through the composer's real file input; `scroll` scrolls the transcript.
 *
 * A role step takes the first match unless `nth` (from zero) picks another, as with two composers.
 */
export type StressStep =
  | { action: 'click'; role: string; name: string; nth?: number }
  | { action: 'fill'; role: string; name: string; text: string; nth?: number }
  | { action: 'focus'; role: string; name: string; nth?: number }
  | { action: 'focus-source' }
  | { action: 'expect-source-open' }
  | { action: 'press'; key: string }
  | { action: 'hook'; name: string; argument?: unknown }
  | { action: 'expect'; role: string; name: string; nth?: number; scope?: string }
  | { action: 'expect-text'; text: string; scope?: string; exact?: boolean }
  | { action: 'expect-offscreen'; selector: string }
  | { action: 'expect-absent'; selector: string }
  | { action: 'upload'; files: readonly StressUpload[] }
  | { action: 'scroll'; to: 'top' | 'bottom' };

/** A file the `upload` step hands to the composer's real file input. */
export interface StressUpload {
  readonly name: string;
  readonly mimeType: string;
  /** The size in bytes; the file's bytes are zeros. */
  readonly bytes: number;
}

/** A second image of a case, taken after its own flow from a fresh load: `<width>-<theme>-<case>-<name>.png`. */
export interface StressVariant {
  /** The suffix of the image name, such as `expanded`. */
  readonly name: string;
  /** The flow that reaches the variant, from a fresh load of the case. */
  readonly steps: readonly StressStep[];
}

/** One stress case. */
export interface StressCase {
  /** The case number, 1 to 80, unique. */
  readonly id: number;
  /** A short kebab-case name. */
  readonly slug: string;
  /** What the case proves, in a sentence. */
  readonly title: string;
  /** Whether an issue names the case or it is derived from a design row. */
  readonly provenance: StressProvenance;
  /** For an issue-named case, the issue and what it says; for a derived one, why it exists. */
  readonly source: string;
  /** The design rows the case shows, such as `C3`. At least one. */
  readonly rows: readonly string[];
  /** The scenario builder that makes the conversation and Chat's props (`stress-scenarios.ts`). */
  readonly scenario: StressScenarioName;
  /** What the scenario takes. */
  readonly params: Readonly<Record<string, unknown>>;
  /** The flow that reaches the primary image, from a fresh load. */
  readonly steps: readonly StressStep[];
  /** The extra images of the case, each from a fresh load. */
  readonly variants: readonly StressVariant[];
  /** Whether the capture tool also tabs through every control and takes one image per focus stop. */
  readonly focusSweep: boolean;
  /** The case whose composer edge this case must match, for the pairs 9 and 10, and 14 and 15. */
  readonly composerEdgeWith?: number;
  /** The writing direction the case is in, when it is not left to right. */
  readonly direction?: 'rtl';
  /**
   * Set when the design row the case names cannot be shown by this fixture; the capture still takes
   * the case's images but reports it as deferred with this reason, never as proof of the row.
   */
  readonly deferred?: string;
}

/** The sample world's "now": every case runs with the browser's clock fixed here, so a date reads Today. */
export const STRESS_NOW = '2026-11-02T16:46:00.000Z';

/** The number of cases the board requires. */
export const STRESS_CASE_COUNT = 80;

/**
 * The scenario builders a case may name (`stress-scenarios.ts` builds one for each). The list lives
 * here, with no Chat import, so the case tests can check a case's scenario without loading Chat.
 */
export const STRESS_SCENARIO_NAMES = [
  'approval',
  'attachments',
  'availability',
  'citations',
  'code-blocks',
  'composer-status',
  'composer-sweep',
  'date-and-actions',
  'empty-first-use',
  'idle',
  'images',
  'long-transcript',
  'missing-source',
  'question',
  'reasoning',
  'rtl',
  'run',
  'stream-code',
  'tool-group',
  'turn-state',
  'two-composers',
  'wide-table',
] as const;

/** One scenario name. */
export type StressScenarioName = (typeof STRESS_SCENARIO_NAMES)[number];

/** The steps a case's JSON may carry, by action. */
const STEP_ACTIONS = [
  'click',
  'fill',
  'focus',
  'focus-source',
  'expect-source-open',
  'press',
  'hook',
  'expect',
  'expect-text',
  'expect-offscreen',
  'expect-absent',
  'upload',
  'scroll',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function problemsInStep(step: unknown, where: string): string[] {
  if (!isRecord(step)) return [`${where}: a step must be an object`];
  const action = step['action'];
  if (typeof action !== 'string' || !(STEP_ACTIONS as readonly string[]).includes(action)) {
    return [`${where}: unknown step action ${JSON.stringify(action)}`];
  }
  const needsRole =
    action === 'click' || action === 'fill' || action === 'focus' || action === 'expect';
  const problems: string[] = [];
  if (action === 'upload' && !Array.isArray(step['files']))
    problems.push(`${where}: upload needs files`);
  if (action === 'scroll' && step['to'] !== 'top' && step['to'] !== 'bottom') {
    problems.push(`${where}: scroll goes to top or bottom`);
  }
  if (needsRole) {
    if (typeof step['role'] !== 'string' || step['role'] === '')
      problems.push(`${where}: ${action} needs a role`);
    if (typeof step['name'] !== 'string' || step['name'] === '')
      problems.push(`${where}: ${action} needs a name`);
  }
  if (action === 'fill' && typeof step['text'] !== 'string')
    problems.push(`${where}: fill needs text`);
  if (action === 'press' && typeof step['key'] !== 'string')
    problems.push(`${where}: press needs a key`);
  if (action === 'hook' && typeof step['name'] !== 'string')
    problems.push(`${where}: hook needs a name`);
  if (action === 'expect-text' && typeof step['text'] !== 'string')
    problems.push(`${where}: expect-text needs text`);
  return problems;
}

function problemsInCase(value: unknown, index: number): string[] {
  const where = `case at position ${index + 1}`;
  if (!isRecord(value)) return [`${where}: must be an object`];
  const problems: string[] = [];
  const id = value['id'];
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 1 || id > STRESS_CASE_COUNT) {
    problems.push(`${where}: id must be an integer from 1 to ${STRESS_CASE_COUNT}`);
  }
  if (
    typeof value['scenario'] !== 'string' ||
    !(STRESS_SCENARIO_NAMES as readonly string[]).includes(value['scenario'])
  ) {
    problems.push(`${where}: scenario must be one of ${STRESS_SCENARIO_NAMES.join(', ')}`);
  }
  for (const key of ['slug', 'title', 'source'] as const) {
    if (typeof value[key] !== 'string' || value[key] === '')
      problems.push(`${where}: ${key} must be a sentence or a name`);
  }
  if (value['provenance'] !== 'issue-named' && value['provenance'] !== 'derived') {
    problems.push(`${where}: provenance must be issue-named or derived`);
  }
  const rows = value['rows'];
  if (!Array.isArray(rows) || rows.length === 0 || rows.some((row) => typeof row !== 'string')) {
    problems.push(`${where}: rows must name at least one design row`);
  }
  if (!isRecord(value['params'])) problems.push(`${where}: params must be an object`);
  if (typeof value['focusSweep'] !== 'boolean')
    problems.push(`${where}: focusSweep must be a boolean`);
  const steps = value['steps'];
  if (!Array.isArray(steps)) problems.push(`${where}: steps must be an array`);
  else {
    steps.forEach((step, stepIndex) =>
      problems.push(...problemsInStep(step, `${where} step ${stepIndex + 1}`)),
    );
    const sourceOpenIndex = steps.findIndex(
      (step) => isRecord(step) && step['action'] === 'expect-source-open',
    );
    if (sourceOpenIndex >= 0) {
      if (value['scenario'] !== 'citations') {
        problems.push(`${where}: expect-source-open belongs to a citations case`);
      }
      const withdrawalIndex = steps.findIndex(
        (step) => isRecord(step) && step['action'] === 'hook' && step['name'] === 'withdrawSource',
      );
      if (withdrawalIndex < 0 || sourceOpenIndex > withdrawalIndex) {
        problems.push(`${where}: expect-source-open must precede withdrawSource`);
      }
    }
  }
  const variants = value['variants'];
  if (!Array.isArray(variants)) problems.push(`${where}: variants must be an array`);
  else {
    variants.forEach((variant, variantIndex) => {
      const label = `${where} variant ${variantIndex + 1}`;
      if (!isRecord(variant) || typeof variant['name'] !== 'string' || variant['name'] === '') {
        problems.push(`${label}: a variant needs a name`);
        return;
      }
      const variantSteps = variant['steps'];
      if (!Array.isArray(variantSteps)) problems.push(`${label}: steps must be an array`);
      else
        variantSteps.forEach((step, stepIndex) =>
          problems.push(...problemsInStep(step, `${label} step ${stepIndex + 1}`)),
        );
    });
  }
  return problems;
}

/**
 * Everything wrong with a list of cases: a malformed case, a duplicate or missing number, a
 * composer-edge partner that is not a case, or a variant name used twice by one case. An empty
 * list means the data is usable.
 */
export function stressCaseProblems(cases: unknown): string[] {
  if (!Array.isArray(cases)) return ['the cases must be an array'];
  const problems = cases.flatMap((value, index) => problemsInCase(value, index));
  if (problems.length > 0) return problems;
  const typed = cases as StressCase[];
  const seen = new Set<number>();
  for (const stressCase of typed) {
    if (seen.has(stressCase.id)) problems.push(`case ${stressCase.id} appears twice`);
    seen.add(stressCase.id);
    const names = stressCase.variants.map((variant) => variant.name);
    if (new Set(names).size !== names.length)
      problems.push(`case ${stressCase.id} repeats a variant name`);
    if (
      stressCase.composerEdgeWith !== undefined &&
      !typed.some((other) => other.id === stressCase.composerEdgeWith)
    ) {
      problems.push(
        `case ${stressCase.id} names composer-edge partner ${stressCase.composerEdgeWith}, which is not a case`,
      );
    }
  }
  for (let id = 1; id <= STRESS_CASE_COUNT; id += 1) {
    if (!seen.has(id)) problems.push(`case ${id} is missing`);
  }
  if (typed.length !== STRESS_CASE_COUNT)
    problems.push(`expected ${STRESS_CASE_COUNT} cases, found ${typed.length}`);
  return problems;
}

/** The cases, checked; throws with every problem when the data is not usable. */
export function parseStressCases(cases: unknown): readonly StressCase[] {
  const problems = stressCaseProblems(cases);
  if (problems.length > 0)
    throw new Error(`Chat stress cases are invalid:\n${problems.join('\n')}`);
  return (cases as StressCase[]).toSorted((left, right) => left.id - right.id);
}

/** The case with this number, or `undefined` when no case has it. */
export function findStressCase(cases: readonly StressCase[], id: number): StressCase | undefined {
  return cases.find((candidate) => candidate.id === id);
}

/** The case number as the image names write it: two digits, such as `09`. */
export function caseLabel(id: number): string {
  return String(id).padStart(2, '0');
}
