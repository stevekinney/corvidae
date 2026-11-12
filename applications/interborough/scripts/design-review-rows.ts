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
 */
import { readFile } from 'node:fs/promises';

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

/** What checking a verdicts file found. */
export interface RowCheck {
  readonly problems: readonly string[];
  readonly counts: Readonly<Record<RowVerdict, number>>;
}

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

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
  if (verdictLines.length !== rows.length) {
    problems.push(`expected ${rows.length} verdict lines, one per row, got ${verdictLines.length}`);
  }
  for (const [index, line] of verdictLines.entries()) {
    const label = `verdicts line ${index + 1}`;
    const parts = fields(line);
    if (parts.length !== 3) {
      problems.push(`${label}: expected "row-id | verdict | evidence", got "${line}"`);
      continue;
    }
    const [id = '', verdict = '', evidence = ''] = parts;
    const expected = rows[index]?.id;
    if (id !== expected) {
      problems.push(`${label}: expected row ${expected ?? '(none)'}, got ${id}`);
    }
    if (!isVerdict(verdict)) {
      problems.push(`${label}: "${verdict}" is not one of ${ROW_VERDICTS.join(', ')}`);
      continue;
    }
    counts[verdict] += 1;
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
  return { problems, counts };
}

/** The overall implementation-review verdict the row verdicts imply. */
export function overallVerdict(
  counts: Readonly<Record<RowVerdict, number>>,
): 'approve' | 'changes required' {
  const failing: RowVerdict[] = ['drifted', 'partial', 'missing', 'unverified'];
  return failing.some((verdict) => counts[verdict] > 0) ? 'changes required' : 'approve';
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
