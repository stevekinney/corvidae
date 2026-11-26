/**
 * Checks a design review's per-row verdicts against the rows it was given (`.agents/skills/design-review`,
 * implementation-review and drift-audit modes). Both files are pipe-separated, one row per line, no
 * header:
 *
 *   rows file:      row-id | board | requirement text
 *   verdicts file:  row-id | verdict | evidence
 *
 * A requirement says what should be true; a row that opens with "Was:" states only a defect and is
 * refused. The verdicts must name every input row exactly once, in input order, with a verdict from
 * {@link ROW_VERDICTS}; `superseded` belongs only to a drift audit and `deferred` only to an
 * implementation review, and every verdict but `matches` carries evidence. A review whose verdicts
 * fail any of this is a failed review, not a partial pass, so the chef close gate and the design
 * ledger can trust a file that passes.
 *
 *   bun scripts/design-review-rows.ts --mode implementation-review|drift-audit --rows <file> --verdicts <file>
 *
 * Prints one summary line (the count per verdict) and, for an implementation review, the derived
 * overall verdict. Exit 0 when the verdicts are well formed, 1 with one line per problem when they
 * are not, 2 on bad usage.
 *
 * Every review also answers the owner's standing rules ({@link OWNER_RULE_ROWS}): seven fixed rows
 * the verdicts file ends with, after the issue's own rows. A verdicts file that omits one is
 * invalid. `--checklist` prints those lines as a template.
 *
 * The same module turns an issue's `rows.resolved.json` into the capture manifest that
 * `design-review-capture.ts --expect` holds a capture to: every row's declared states by route,
 * state, theme and width, the widest width first so a review leads with it.
 *
 *   bun scripts/design-review-rows.ts --manifest <rows.resolved.json> [--only <id,id>] [--out <file>]
 */
import { readFile, writeFile } from 'node:fs/promises';

import {
  DEFAULT_THEMES,
  DEFAULT_WIDTHS,
  isWitnessTarget,
  validateResolved,
  WITNESS_SPECIFICATION,
  WITNESS_WORLDS,
  type ResolvedRows,
  type StateKind,
  type ViewportWitnessProfile,
} from '../../../scripts/chef/design-rows-resolved.ts';

/** Every verdict a row can receive. */
export const ROW_VERDICTS = [
  'matches',
  'drifted',
  'partial',
  'missing',
  'superseded',
  'deferred',
  'unverified',
] as const;

/** One verdict a row can receive. */
export type RowVerdict = (typeof ROW_VERDICTS)[number];

/** The two review modes that produce per-row verdicts. */
export type RowReviewMode = 'implementation-review' | 'drift-audit';

/** One line of a rows file. */
export interface DesignRow {
  readonly id: string;
  readonly board: string;
  readonly text: string;
}

/** One line of a verdicts file. */
export interface RowVerdictLine {
  readonly id: string;
  readonly verdict: RowVerdict;
  readonly evidence: string;
}

/** The longest evidence a verdict line may carry. */
export const MAXIMUM_EVIDENCE_LENGTH = 300;

/**
 * The owner's standing rules, which every review answers as a verdict row of its own after the
 * issue's rows (2026-11-19 corrections, sections 1 and 2: about 30 defects found on screens that
 * had passed review). `matches` says the rule holds on every screen captured, `drifted` that a
 * screen breaks it (the evidence names the capture), `unverified` that no capture can show it.
 * Where a rule can be checked mechanically a guard owns it; the row is the reviewer's check of the
 * rest.
 */
export const OWNER_RULE_ROWS = [
  { id: 'rule-middle-dots', rule: 'No middle dot (U+00B7) separates pieces of visible copy.' },
  { id: 'rule-sidebar-headings', rule: 'The sidebar carries no section headings.' },
  {
    id: 'rule-surfaces',
    rule: 'Light mode is not faded, and dark mode has no bright shadows or glows.',
  },
  {
    id: 'rule-visible-identifiers',
    rule: 'No file path, ULID or secret reference appears in visible text.',
  },
  { id: 'rule-empty-state', rule: 'Every empty state uses the one EmptyState layout.' },
  { id: 'rule-wide-widths', rule: 'Nothing is stretched across the page at 1920 and 1280 pixels.' },
  { id: 'rule-aligned-headers', rule: 'Page headers and top-bar controls share one centre line.' },
] as const;

/** The verdicts a checklist row may take: it either holds, is broken, or cannot be seen. */
const OWNER_RULE_VERDICTS: readonly RowVerdict[] = ['matches', 'drifted', 'unverified'];

/**
 * The template a review's verdicts file ends with: each rule as a comment line, then its row to
 * fill in. The template itself fails the check, because `<verdict>` is no verdict.
 */
export function ownerRuleTemplate(): string[] {
  return OWNER_RULE_ROWS.flatMap(({ id, rule }) => [`# ${rule}`, `${id} | <verdict> | <evidence>`]);
}

/** What checking a verdicts file found. */
export interface RowCheck {
  readonly problems: readonly string[];
  readonly counts: Readonly<Record<RowVerdict, number>>;
}

/** The non-blank lines of a file, leaving out `#` comment lines. */
function lines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
}

const OWNER_RULE_IDS: readonly string[] = OWNER_RULE_ROWS.map(({ id }) => id);

function fields(line: string): string[] {
  return line.split('|').map((field) => field.trim());
}

/**
 * A requirement that is nothing but its "Was:" clause. A row taken from an audit finding says what
 * should be true and then what was wrong; a reviewer handed only the defect reads it as the
 * requirement and asks for the defect back.
 */
const DEFECT_ONLY = /^was\s*:/i;

/** A rows file read: its rows, or the problems that make it unreadable. */
export type ParsedRows =
  | { readonly ok: true; readonly rows: readonly DesignRow[] }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Reads a rows file, or answers the problems that make it unreadable. */
export function parseRows(text: string): ParsedRows {
  const rows: DesignRow[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [index, line] of lines(text).entries()) {
    const parts = fields(line);
    const [id = '', board = '', ...rest] = parts;
    if (parts.length < 3 || id === '' || board === '') {
      problems.push(`rows line ${index + 1}: expected "row-id | board | text", got "${line}"`);
      continue;
    }
    if (DEFECT_ONLY.test(rest.join(' '))) {
      problems.push(
        `rows line ${index + 1}: row ${id} states only what was wrong; say what should be true, then "Was: …"`,
      );
    }
    if (OWNER_RULE_IDS.includes(id))
      problems.push(`rows line ${index + 1}: ${id} is an owner-rule row, which every review adds`);
    if (seen.has(id)) problems.push(`rows line ${index + 1}: row ${id} appears twice`);
    seen.add(id);
    rows.push({ id, board, text: rest.join(' / ') });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, rows };
}

function isVerdict(value: string): value is RowVerdict {
  return (ROW_VERDICTS as readonly string[]).includes(value);
}

/** Checks a verdicts file against the rows it answers, under the rules of `mode`. */
export function checkVerdicts(
  rows: readonly DesignRow[],
  verdictsText: string,
  mode: RowReviewMode,
): RowCheck {
  const problems: string[] = [];
  const counts = Object.fromEntries(ROW_VERDICTS.map((verdict) => [verdict, 0])) as Record<
    RowVerdict,
    number
  >;
  const verdictLines = lines(verdictsText);
  // The issue's rows in input order, then the owner's rules: a review that omits one is invalid.
  const expectedIds = [...rows.map(({ id }) => id), ...OWNER_RULE_IDS];
  if (verdictLines.length !== expectedIds.length) {
    problems.push(
      `expected ${expectedIds.length} verdict lines, one per row (${rows.length}) and one per owner rule (${OWNER_RULE_IDS.length}), got ${verdictLines.length}`,
    );
  }
  for (const [index, line] of verdictLines.entries()) {
    const label = `verdicts line ${index + 1}`;
    const parts = fields(line);
    if (parts.length !== 3) {
      problems.push(`${label}: expected "row-id | verdict | evidence", got "${line}"`);
      continue;
    }
    const [id = '', verdict = '', evidence = ''] = parts;
    const expected = expectedIds[index];
    if (id !== expected) {
      problems.push(`${label}: expected row ${expected ?? '(none)'}, got ${id}`);
    }
    if (!isVerdict(verdict)) {
      problems.push(`${label}: "${verdict}" is not one of ${ROW_VERDICTS.join(', ')}`);
      continue;
    }
    counts[verdict] += 1;
    if (OWNER_RULE_IDS.includes(id) && !OWNER_RULE_VERDICTS.includes(verdict)) {
      problems.push(
        `${label}: owner rule ${id} takes ${OWNER_RULE_VERDICTS.join(', ')}, not ${verdict}`,
      );
      continue;
    }
    if (verdict === 'superseded' && mode !== 'drift-audit') {
      problems.push(`${label}: superseded belongs to a drift audit only`);
    }
    if (verdict === 'deferred' && mode !== 'implementation-review') {
      problems.push(`${label}: deferred belongs to an implementation review only`);
    }
    if (verdict !== 'matches' && evidence === '') {
      problems.push(`${label}: ${verdict} needs evidence`);
    }
    if (evidence.length > MAXIMUM_EVIDENCE_LENGTH) {
      problems.push(`${label}: evidence is longer than ${MAXIMUM_EVIDENCE_LENGTH} characters`);
    }
  }
  const answered = new Set(verdictLines.map((line) => fields(line)[0]));
  for (const id of OWNER_RULE_IDS)
    if (!answered.has(id)) problems.push(`owner-rule row ${id} is missing from the verdicts`);
  return { problems, counts };
}

/** The overall implementation-review verdict the row verdicts imply. */
export function overallVerdict(
  counts: Readonly<Record<RowVerdict, number>>,
): 'approve' | 'changes required' {
  const failing: RowVerdict[] = ['drifted', 'partial', 'missing', 'unverified'];
  return failing.some((verdict) => counts[verdict] > 0) ? 'changes required' : 'approve';
}

/** One capture a design row needs: where, in which state, in which theme and at which width. */
export interface CaptureExpectation {
  readonly row: string;
  readonly route: string;
  readonly state: string;
  readonly kind: StateKind;
  readonly theme: 'light' | 'dark';
  readonly width: number;
}

/** One physical proof a narrow Playwright run must return for a declared state and profile. */
export interface ViewportWitnessExpectation extends ViewportWitnessProfile {
  readonly row: string;
  readonly route: string;
  readonly state: string;
  readonly kind: StateKind;
  readonly specification: string;
  readonly title: string;
  readonly world: string;
}

/** The durable identifier a capture records for a row's physical proof. */
function viewportWitnessKey(entry: Pick<ViewportWitnessExpectation, 'row' | 'name'>): string {
  return `${entry.row}:${entry.name}`;
}

/** The expected-captures file `--manifest` writes and `design-review-capture.ts --expect` reads. */
export interface CaptureManifest {
  readonly version: 2;
  readonly issue: string;
  readonly captures: readonly CaptureExpectation[];
  readonly witnesses: readonly ViewportWitnessExpectation[];
}

/**
 * The capture manifest of a resolved rows file: one entry per row, declared state, theme and
 * width. The widest width comes first across the whole manifest (the owner works at about 1,950
 * pixels, so a review leads with 1920 and 1280), then light before dark, then the rows in file
 * order. A row that declares no state yields nothing, so it is the validator's to refuse.
 */
export function captureManifest(resolved: ResolvedRows, only?: readonly string[]): CaptureManifest {
  const entries: CaptureExpectation[] = [];
  const witnesses: ViewportWitnessExpectation[] = [];
  for (const row of resolved.rows) {
    if (only !== undefined && !only.includes(row.id)) continue;
    for (const width of row.widths ?? DEFAULT_WIDTHS)
      for (const theme of row.themes ?? DEFAULT_THEMES)
        for (const { route, state, kind } of row.states)
          entries.push({ row: row.id, route, state, kind, theme, width });
    for (const { route, state, kind, witness } of row.states)
      for (const profile of witness.profiles)
        witnesses.push({
          row: row.id,
          route,
          state,
          kind,
          specification: witness.specification,
          title: witness.title,
          world: witness.world,
          ...profile,
        });
  }
  const themeOrder = { light: 0, dark: 1 } as const;
  const position = (entry: CaptureExpectation) =>
    resolved.rows.findIndex((row) => row.id === entry.row);
  const sorted = entries.toSorted(
    (left, right) =>
      right.width - left.width ||
      themeOrder[left.theme] - themeOrder[right.theme] ||
      position(left) - position(right),
  );
  return { version: 2, issue: resolved.issue, captures: sorted, witnesses };
}

/** One line of the capture's `manifest.jsonl`, as far as coverage reads it. */
export interface CapturedLine {
  readonly route?: unknown;
  readonly state?: unknown;
  readonly width?: unknown;
  readonly colorScheme?: unknown;
  readonly source?: unknown;
  readonly world?: unknown;
  readonly viewport?: unknown;
  readonly witnesses?: unknown;
}

/** The expected captures no line of `captured` shows, each once, in manifest order. */
export function missingCaptures(
  expected: readonly CaptureExpectation[],
  captured: readonly CapturedLine[],
): CaptureExpectation[] {
  const seen = new Set(
    captured.map((line) => JSON.stringify([line.route, line.state, line.width, line.colorScheme])),
  );
  const reported = new Set<string>();
  return expected.filter((entry) => {
    const key = JSON.stringify([entry.route, entry.state, entry.width, entry.theme]);
    if (seen.has(key) || reported.has(key)) return false;
    reported.add(key);
    return true;
  });
}

/** The narrow physical witnesses no actual viewport capture proves. */
export function missingViewportWitnesses(
  expected: readonly ViewportWitnessExpectation[],
  captured: readonly CapturedLine[],
): ViewportWitnessExpectation[] {
  return expected.filter((entry) => viewportWitnessProof(entry, captured) === undefined);
}

/**
 * The capture line that proves a witness: its declared source, route, world, state, width and
 * theme, an actual viewport frame (never a `.full.png`), and the witness's key recorded on it.
 */
export function viewportWitnessProof(
  entry: ViewportWitnessExpectation,
  captured: readonly CapturedLine[],
): (CapturedLine & { readonly viewport: string }) | undefined {
  return captured.find(
    (line): line is CapturedLine & { readonly viewport: string } =>
      typeof line.source === 'string' &&
      entry.specification.endsWith(`/${line.source}`) &&
      line.route === entry.route &&
      line.world === entry.world &&
      line.state === entry.state &&
      line.width === entry.width &&
      line.colorScheme === entry.theme &&
      typeof line.viewport === 'string' &&
      !line.viewport.endsWith('.full.png') &&
      Array.isArray(line.witnesses) &&
      line.witnesses.includes(viewportWitnessKey(entry)),
  );
}

/** One missing capture as a line a reader can act on. */
export function describeMissing(entry: CaptureExpectation): string {
  return `missing capture: route ${entry.route}, state "${entry.state}" (${entry.kind}), width ${entry.width}, ${entry.theme}, declared by row ${entry.row}`;
}

/** Said when every missing capture is at 1920, which only `chef/capture-1920` produces. */
export const WIDE_CAPTURE_DEPENDENCY =
  '1920 captures come from chef/capture-1920 (COR-2445); until it lands, a plan that expects 1920 cannot be covered';

/** The dependency hint when every missing capture is at 1920, otherwise nothing. */
export function wideCaptureHint(
  missing: readonly { readonly width?: unknown }[],
): string | undefined {
  return missing.length > 0 && missing.every((entry) => entry.width === 1920)
    ? WIDE_CAPTURE_DEPENDENCY
    : undefined;
}

/** Reads an expected-captures file, or answers what is wrong with it. */
export function parseCaptureManifest(text: string): CaptureManifest | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'the capture manifest is not JSON';
  }
  const file = parsed as Partial<CaptureManifest> | null;
  if (file?.version !== 2 || !Array.isArray(file.captures) || !Array.isArray(file.witnesses))
    return 'the capture manifest needs version 2, captures and witnesses lists';
  // An empty plan is covered by anything, so it is no plan.
  if (file.captures.length === 0) return 'the capture manifest expects no captures';
  // The witnesses become Playwright arguments and locators, so a hand-edited file is held to the
  // same shapes `validateResolved` holds the rows to.
  const malformed = file.witnesses.findIndex((witness) => !wellFormedWitness(witness));
  if (malformed !== -1) return `the capture manifest's witness ${malformed + 1} is malformed`;
  return file as CaptureManifest;
}

function wellFormedWitness(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const witness = value as Partial<Record<keyof ViewportWitnessExpectation, unknown>>;
  return (
    typeof witness.specification === 'string' &&
    WITNESS_SPECIFICATION.test(witness.specification) &&
    typeof witness.title === 'string' &&
    witness.title.trim() !== '' &&
    !witness.title.includes('\n') &&
    (witness.theme === 'light' || witness.theme === 'dark') &&
    Number.isInteger(witness.width) &&
    (witness.width as number) > 0 &&
    (witness.scrolling === 'none' || witness.scrolling === 'outlet') &&
    Array.isArray(witness.targets) &&
    witness.targets.length > 0 &&
    witness.targets.every(isWitnessTarget) &&
    (WITNESS_WORLDS as readonly unknown[]).includes(witness.world) &&
    [witness.row, witness.name, witness.route, witness.state, witness.visible].every(
      (field) => typeof field === 'string' && field !== '',
    )
  );
}

/** Writes or prints the capture manifest of a resolved rows file, or the checklist template. */
async function emitManifest(argv: readonly string[], streams: RowReportStreams): Promise<number> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] ?? '';
    const value = argv[index + 1];
    if (!['--manifest', '--only', '--out'].includes(flag)) {
      streams.standardError(`unknown flag ${flag}\n`);
      return 2;
    }
    if (value === undefined || value.startsWith('--')) {
      streams.standardError(`${flag} needs a value\n`);
      return 2;
    }
    values.set(flag, value);
  }
  const path = values.get('--manifest') ?? '';
  let resolved: ResolvedRows;
  try {
    resolved = JSON.parse(await readFile(path, 'utf8')) as ResolvedRows;
  } catch {
    streams.standardError(`cannot read ${path} as JSON\n`);
    return 1;
  }
  // The file is held to the rows it declares: states, widths and conflicts, not another issue's.
  const problems = validateResolved(resolved, {
    issue: resolved.issue,
    rowIds: (resolved.rows ?? []).map((row) => row.id),
    literals: [],
  });
  if (problems.length > 0) {
    streams.standardError(`${problems.join('\n')}\n`);
    return 1;
  }
  const only = values.get('--only')?.split(',');
  const unknown = (only ?? []).filter((id) => !resolved.rows.some((row) => row.id === id));
  if (unknown.length > 0) {
    streams.standardError(`--only names no row of ${resolved.issue}: ${unknown.join(', ')}\n`);
    return 1;
  }
  const manifest = captureManifest(resolved, only);
  if (manifest.captures.length === 0) {
    streams.standardError('the capture manifest would expect nothing\n');
    return 1;
  }
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const out = values.get('--out');
  if (out === undefined) streams.standardOutput(text);
  else {
    await writeFile(out, text);
    streams.standardOutput(
      `design review rows: ${manifest.captures.length} expected captures in ${out}\n`,
    );
  }
  return 0;
}

/** The parsed command line. */
interface Options {
  readonly mode: RowReviewMode;
  readonly rows: string;
  readonly verdicts: string;
}

/** Reads the command line, or answers the usage error to print. */
export function parseArguments(argv: readonly string[]): Options | string {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index] ?? '';
    const value = argv[index + 1];
    if (!['--mode', '--rows', '--verdicts'].includes(flag)) return `unknown flag ${flag}`;
    if (value === undefined || value.startsWith('--')) return `${flag} needs a value`;
    values.set(flag, value);
  }
  const mode = values.get('--mode');
  if (mode !== 'implementation-review' && mode !== 'drift-audit') {
    return '--mode must be implementation-review or drift-audit';
  }
  const rows = values.get('--rows');
  const verdicts = values.get('--verdicts');
  if (rows === undefined || verdicts === undefined) return '--rows and --verdicts are required';
  return { mode, rows, verdicts };
}

/** Where a check writes its report. */
export interface RowReportStreams {
  readonly standardOutput: (text: string) => void;
  readonly standardError: (text: string) => void;
}

/** The process's own output streams. */
export const hostStreams: RowReportStreams = {
  standardOutput: process.stdout.write.bind(process.stdout),
  standardError: process.stderr.write.bind(process.stderr),
};

/** Checks the rows and verdicts files the command line names and answers the exit code. */
export async function checkRowFiles(
  argv: readonly string[] = process.argv.slice(2),
  streams: RowReportStreams = hostStreams,
): Promise<number> {
  if (argv[0] === '--manifest') return emitManifest(argv, streams);
  if (argv[0] === '--checklist') {
    streams.standardOutput(`${ownerRuleTemplate().join('\n')}\n`);
    return 0;
  }
  const options = parseArguments(argv);
  if (typeof options === 'string') {
    streams.standardError(`${options}\n`);
    return 2;
  }
  const parsed = parseRows(await readFile(options.rows, 'utf8'));
  if (!parsed.ok) {
    streams.standardError(`${parsed.problems.join('\n')}\n`);
    return 1;
  }
  const check = checkVerdicts(parsed.rows, await readFile(options.verdicts, 'utf8'), options.mode);
  const summary = ROW_VERDICTS.filter((verdict) => check.counts[verdict] > 0)
    .map((verdict) => `${verdict} ${check.counts[verdict]}`)
    .join(', ');
  streams.standardOutput(`design review rows: ${summary || 'no verdicts'}\n`);
  if (check.problems.length > 0) {
    streams.standardError(`${check.problems.join('\n')}\n`);
    return 1;
  }
  if (options.mode === 'implementation-review') {
    streams.standardOutput(`VERDICT: ${overallVerdict(check.counts)}\n`);
  }
  return 0;
}

if (import.meta.main) process.exitCode = await checkRowFiles();
