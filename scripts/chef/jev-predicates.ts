#!/usr/bin/env bun
// Chef Jev predicates: a registry of the coordinator's routine and owner questions, each with a
// describe() that turns evidence into a Jev question, a capped state summary and an answer spec,
// plus a shadow log. Shadow mode asks Jev what it would answer, records the answer next to the
// eventual actual outcome, and never changes control flow, so agreement can be measured before any
// predicate is trusted to decide. See jev.ts for the wire format, thresholds and exit codes.
//
// Usage:
//   bun scripts/chef/jev-predicates.ts list [--json]
//   bun scripts/chef/jev-predicates.ts shadow <predicate> --evidence-file <json> [--json]
//   bun scripts/chef/jev-predicates.ts outcome <id> --actual <value> [--json]
//   bun scripts/chef/jev-predicates.ts report [--json]
//
// The log is `<main checkout>/tmp/chef/jev-shadow.jsonl`: one `shadow` line per call (`id`, a stable
// hash of predicate and state; `predicate`, `at`, `state`, `decision`, `confidence`, `outcome`,
// `latencyMs`) and one `actual` line per recorded outcome (`id`, `actual`, `at`).
//
// Exit codes: 0 ok (shadow exits 0 even when Jev is unavailable or below threshold), 1 failed (an
// outcome for an id with no shadow record, or the log cannot be written), 2 invalid usage.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  decide,
  defaultJevDependencies,
  defaultThreshold,
  sha256,
  type JevDependencies,
  type Kind,
  type Mode,
  type Outcome,
} from './jev.ts';
import { emitResult, parseOptions, UsageError } from './process-runner.ts';

/** The most characters of evidence state sent to Jev and kept in the log. */
export const STATE_LIMIT = 2000;
const TRUNCATION_MARKER = '…[truncated]';

export interface Description {
  question: string;
  state: string;
  mode: Mode;
}

export interface Predicate {
  id: string;
  kind: Kind;
  describe: (evidence: Record<string, unknown>) => Description;
}

// Evidence helpers ---------------------------------------------------------------------------

/** Cap `text` at `limit` characters, ending in a marker when it was cut. Deterministic. */
export function truncateState(text: string, limit = STATE_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(limit - TRUNCATION_MARKER.length, 0))}${TRUNCATION_MARKER}`;
}

function format(value: unknown): string {
  if (value === undefined || value === null) return 'unknown';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim() || 'empty';
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.map(format).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return `${value}`;
  return 'unknown';
}

/** One `name: value` line per field, in the order given, capped at the state limit. */
function summarize(
  evidence: Record<string, unknown>,
  fields: [name: string, key: string][],
): string {
  return truncateState(fields.map(([name, key]) => `${name}: ${format(evidence[key])}`).join('\n'));
}

function choices(options: Record<string, string>): Mode {
  return { type: 'choice', options };
}

// Predicates ---------------------------------------------------------------------------------

export const PREDICATES: Predicate[] = [
  {
    id: 'thread-triage',
    kind: 'routine',
    describe: (evidence) => ({
      question:
        'A reviewer left this review thread on a Corvidae pull request. Judged against the repository ' +
        'review guidelines, should the author fix it, decline it, or track it? A finding is blocking ' +
        'only when it names a supported input, the wrong result and its concrete consequence; ' +
        'comments on lines the pull request did not change are declined; findings that duplicate an ' +
        'existing COR issue are tracked; one-way doors (persisted formats, wire protocols, published ' +
        'exports) get close scrutiny and internal two-way-door code does not.',
      state: summarize(evidence, [
        ['path', 'path'],
        ['line', 'line'],
        ['author', 'author'],
        ['line in diff', 'inDiff'],
        ['linked COR ids', 'corIds'],
        ['body', 'body'],
      ]),
      mode: choices({
        fix: 'A real defect in lines this pull request changed: fix it.',
        decline: 'Not a defect, out of scope, speculative or a nitpick: decline with a reason.',
        tracked: 'Real but out of scope or already captured by a COR issue: track it.',
      }),
    }),
  },
  {
    id: 'review-tier',
    kind: 'routine',
    describe: (evidence) => ({
      question:
        'How much review does this pull request need? none for mechanical or documentation-only ' +
        'changes, light for small contained changes to two-way-door code, full for anything touching ' +
        'a one-way door (persisted format, wire protocol, published export), locks, or turbo.json.',
      state: summarize(evidence, [
        ['files changed', 'files'],
        ['lines added', 'additions'],
        ['lines deleted', 'deletions'],
        ['touches a one-way door', 'oneWayDoor'],
        ['paths', 'paths'],
      ]),
      mode: { type: 'scale', levels: ['none', 'light', 'full'] },
    }),
  },
  {
    id: 'dispatch-plan',
    kind: 'routine',
    describe: (evidence) => ({
      question:
        'Which worker model and effort should implement this issue? sonnet when the interfaces are ' +
        'known and the issue has tests, sonnet-high for larger or subtler work, opus for one-way ' +
        'doors and designs that need judgment.',
      state: summarize(evidence, [
        ['acceptance criteria', 'criteria'],
        ['files', 'files'],
        ['estimated lines', 'estimatedLines'],
        ['one-way door', 'oneWayDoor'],
      ]),
      mode: choices({
        sonnet: 'Economical coding model: known interfaces, tests exist.',
        'sonnet-high': 'Economical model at high effort: larger or subtler work.',
        opus: 'Stronger model: one-way doors or open design judgment.',
      }),
    }),
  },
  {
    id: 'split-before-dispatch',
    kind: 'routine',
    describe: (evidence) => ({
      question:
        'Should this issue be split into smaller issues before a worker is dispatched? Yes when it ' +
        'has many acceptance criteria, spans unrelated files, or is too large for one reviewable pull request.',
      state: summarize(evidence, [
        ['acceptance criteria', 'criteria'],
        ['files', 'files'],
        ['estimated lines', 'estimatedLines'],
        ['one-way door', 'oneWayDoor'],
      ]),
      mode: { type: 'yes-no' },
    }),
  },
  {
    id: 'flake-verdict',
    kind: 'routine',
    describe: (evidence) => ({
      question:
        'A test failed in the gate. Given the control run on the base and a rerun of the same head, ' +
        'is it a flake, a regression this change introduced, or unknown? It is a flake when it also ' +
        'fails on the base or passes on a rerun, and a regression when it fails only on the head, ' +
        'consistently.',
      state: summarize(evidence, [
        ['test', 'test'],
        ['base passed', 'basePassed'],
        ['rerun passed', 'rerunPassed'],
        ['error', 'error'],
      ]),
      mode: choices({
        flake: 'Fails on the base too, or passes on rerun: a flake.',
        regression: 'Fails only on the head and consistently: this change broke it.',
        unknown: 'The evidence does not settle it.',
      }),
    }),
  },
  {
    id: 'drift-action',
    kind: 'routine',
    describe: (evidence) => ({
      question:
        'The drift check found a Linear issue out of step with GitHub. Which action reconciles it? ' +
        'merged-open means a merged pull request leaves the issue open (close it); ' +
        'review-without-pr means an issue in review has no pull request (reopen it); ' +
        'stale-in-progress means no recent activity (link a pull request if one exists, else ignore).',
      state: summarize(evidence, [
        ['issue', 'identifier'],
        ['finding', 'kind'],
        ['issue state', 'state'],
        ['pull request', 'pullRequest'],
      ]),
      mode: choices({
        'close-issue': 'Close the Linear issue: its work has merged.',
        'reopen-issue': 'Move the issue back to an active state.',
        'link-pr': 'Link the matching pull request to the issue.',
        ignore: 'Take no action.',
      }),
    }),
  },
  {
    id: 'escalate',
    kind: 'routine',
    describe: (evidence) => ({
      question:
        'Should this worker be escalated to a stronger model? Yes when it has needed two or more ' +
        'corrections, or the last failure shows the same defect surviving corrections.',
      state: summarize(evidence, [
        ['corrections so far', 'corrections'],
        ['last failure', 'lastFailure'],
      ]),
      mode: { type: 'yes-no' },
    }),
  },
  {
    id: 'criteria-binary',
    kind: 'routine',
    describe: (evidence) => ({
      question:
        'Is every acceptance criterion of this issue binary and independently checkable? Yes when ' +
        'each criterion can only be met or not met and names the test or command that checks it; ' +
        'no when any criterion is subjective, vague, compound without a check, or unverifiable.',
      state: summarize(evidence, [
        ['issue', 'identifier'],
        ['acceptance criteria', 'criteria'],
      ]),
      mode: { type: 'yes-no' },
    }),
  },
  {
    id: 'verification-exact',
    kind: 'routine',
    describe: (evidence) => ({
      question:
        'Does the Verification section of this issue give exact commands a worker can run as ' +
        'written? Yes when every step is a complete command in a code span or block; no when a ' +
        'step is prose, a placeholder, or names a command that cannot run from the repository root.',
      state: summarize(evidence, [
        ['issue', 'identifier'],
        ['verification', 'verification'],
        ['files', 'files'],
      ]),
      mode: { type: 'yes-no' },
    }),
  },
  {
    id: 'unanswered-question',
    kind: 'routine',
    describe: (evidence) => ({
      question:
        'Does this issue still hold an unanswered question? Yes when Decisions or any other ' +
        'section leaves a choice open, defers it ("TBD", "to be decided", a trailing question), or ' +
        'an Open questions section lists anything; no when every question is answered and recorded. ' +
        'A section the issue does not have is not a question: an issue with no Decisions or Open ' +
        'questions section and a settled brief holds no unanswered question.',
      state: summarize(evidence, [
        ['issue', 'identifier'],
        ['brief', 'brief'],
        ['decisions', 'decisions'],
        ['open questions', 'openQuestions'],
      ]),
      mode: { type: 'yes-no' },
    }),
  },
  {
    id: 'premise-stale',
    kind: 'routine',
    describe: (evidence) => ({
      question:
        'Is the premise of this open issue stale? Yes when the files, symbols or issues it names ' +
        'are gone or closed, or the code changed under it, so the description no longer matches the ' +
        'repository; no when the findings are incidental and the premise still holds.',
      state: summarize(evidence, [
        ['issue', 'identifier'],
        ['title', 'title'],
        ['mechanical findings', 'findings'],
      ]),
      mode: { type: 'yes-no' },
    }),
  },
  {
    id: 'already-done',
    kind: 'routine',
    describe: (evidence) => ({
      question:
        'Is the work of this open issue already done? Yes when merged pull requests or the current ' +
        'code deliver its acceptance criteria; no when criteria remain unmet.',
      state: summarize(evidence, [
        ['issue', 'identifier'],
        ['title', 'title'],
        ['merged pull requests', 'mergedPullRequests'],
        ['mechanical findings', 'findings'],
      ]),
      mode: { type: 'yes-no' },
    }),
  },
];

export function findPredicate(id: string): Predicate | undefined {
  return PREDICATES.find((predicate) => predicate.id === id);
}

// Shadow log ---------------------------------------------------------------------------------

export interface ShadowEntry {
  id: string;
  predicate: string;
  at: string;
  state: string;
  decision: string | null;
  confidence: number | null;
  outcome: Outcome;
  latencyMs: number;
}

export interface ActualEntry {
  id: string;
  actual: string;
  at: string;
}

export interface ShadowDependencies extends Partial<JevDependencies> {
  /** A monotonic reading in milliseconds, for latency; tests inject a stepping clock. */
  clock?: () => number;
  /** The log path; defaults to `<main checkout>/tmp/chef/jev-shadow.jsonl`. */
  logPath?: string;
}

/** The stable id of one shadow call: a hash of the predicate and the state it saw. */
export function shadowId(predicate: string, state: string): string {
  return sha256(`${predicate}\n${state}`).slice(0, 16);
}

function logPathOf(dependencies: ShadowDependencies): string {
  if (dependencies.logPath !== undefined) return dependencies.logPath;
  const mainCheckout = (dependencies.mainCheckout ?? defaultJevDependencies().mainCheckout)();
  return join(mainCheckout, 'tmp', 'chef', 'jev-shadow.jsonl');
}

function nowOf(dependencies: ShadowDependencies): Date {
  return (dependencies.now ?? defaultJevDependencies().now)();
}

function append(path: string, entry: ShadowEntry | ActualEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

/**
 * Ask Jev what it would answer and log it. Never throws for Jev or for a log that cannot be
 * written: an unavailable or below-threshold Jev is recorded, and the entry is returned either way.
 */
export async function shadow(
  predicateId: string,
  evidence: Record<string, unknown>,
  dependencies: ShadowDependencies = {},
): Promise<ShadowEntry & { logged: boolean }> {
  const predicate = findPredicate(predicateId);
  if (predicate === undefined) throw new UsageError(`Unknown predicate "${predicateId}".`);
  const description = predicate.describe(evidence);
  const clock = dependencies.clock ?? (() => performance.now());
  const started = clock();
  const decision = await decide(
    {
      question: description.question,
      state: description.state,
      mode: description.mode,
      kind: predicate.kind,
      threshold: defaultThreshold(predicate.kind),
      record: null,
    },
    dependencies,
  );
  const entry: ShadowEntry = {
    id: shadowId(predicate.id, description.state),
    predicate: predicate.id,
    at: nowOf(dependencies).toISOString(),
    state: description.state,
    decision: decision.answer,
    confidence: decision.probability,
    outcome: decision.outcome,
    latencyMs: Math.max(0, Math.round(clock() - started)),
  };
  let logged = true;
  try {
    append(logPathOf(dependencies), entry);
  } catch {
    logged = false;
  }
  return { ...entry, logged };
}

type LogLine = (ShadowEntry & { kind: 'shadow' }) | (ActualEntry & { kind: 'actual' });

/** Read the log; a missing file is empty and a malformed line is skipped. */
export function readLog(path: string): LogLine[] {
  if (!existsSync(path)) return [];
  const lines: LogLine[] = [];
  for (const text of readFileSync(path, 'utf8').split('\n')) {
    if (text.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      if (typeof record['id'] !== 'string') continue;
      if (typeof record['actual'] === 'string')
        lines.push({ ...(record as unknown as ActualEntry), kind: 'actual' });
      else if (typeof record['predicate'] === 'string')
        lines.push({ ...(record as unknown as ShadowEntry), kind: 'shadow' });
    } catch {
      continue;
    }
  }
  return lines;
}

/** Record what actually happened for a shadowed call; returns false when no shadow has that id. */
export function recordOutcome(
  id: string,
  actual: string,
  dependencies: ShadowDependencies = {},
): boolean {
  const path = logPathOf(dependencies);
  if (!readLog(path).some((line) => line.kind === 'shadow' && line.id === id)) return false;
  append(path, { id, actual, at: nowOf(dependencies).toISOString() });
  return true;
}

export interface PredicateReport {
  predicate: string;
  count: number;
  decided: number;
  /** Calls with an answer and a recorded actual. */
  compared: number;
  /** Share of compared calls whose decision equals the actual; null with none compared. */
  agreement: number | null;
  meanLatencyMs: number | null;
}

/** Per predicate: calls, decided calls, agreement where an actual exists, mean latency. */
export function report(path: string): PredicateReport[] {
  const lines = readLog(path);
  const actuals = new Map<string, string>();
  for (const line of lines) if (line.kind === 'actual') actuals.set(line.id, line.actual);
  const rows = new Map<string, ShadowEntry[]>();
  for (const line of lines)
    if (line.kind === 'shadow')
      rows.set(line.predicate, [...(rows.get(line.predicate) ?? []), line]);
  return [...rows.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([predicate, entries]) => {
      const compared = entries.filter((entry) => entry.decision !== null && actuals.has(entry.id));
      const agreed = compared.filter((entry) => entry.decision === actuals.get(entry.id));
      return {
        predicate,
        count: entries.length,
        decided: entries.filter((entry) => entry.outcome === 'decided').length,
        compared: compared.length,
        agreement: compared.length === 0 ? null : agreed.length / compared.length,
        meanLatencyMs: entries.reduce((sum, entry) => sum + entry.latencyMs, 0) / entries.length,
      };
    });
}

// CLI ----------------------------------------------------------------------------------------

function renderReport(rows: PredicateReport[]): string {
  if (rows.length === 0) return 'No shadow calls recorded.';
  return rows
    .map(
      (row) =>
        `${row.predicate} count=${row.count} decided=${row.decided} compared=${row.compared} ` +
        `agreement=${row.agreement === null ? 'n/a' : row.agreement.toFixed(2)} ` +
        `latency=${row.meanLatencyMs === null ? 'n/a' : `${Math.round(row.meanLatencyMs)}ms`}`,
    )
    .join('\n');
}

function readEvidence(file: string | undefined): Record<string, unknown> {
  if (file === undefined) throw new UsageError('--evidence-file is required.');
  if (!existsSync(file)) throw new UsageError(`No such evidence file: ${file}`);
  let evidence: unknown;
  try {
    evidence = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new UsageError(`${file} is not valid JSON.`);
  }
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence))
    throw new UsageError(`${file} must hold a JSON object.`);
  return evidence as Record<string, unknown>;
}

export async function run(
  argv: string[],
  dependencies: ShadowDependencies = {},
): Promise<{ code: number; output: string }> {
  const [command, ...rest] = argv;
  const parsed = parseOptions(rest, { values: ['evidence-file', 'actual'], flags: ['json'] });
  const json = parsed.flags.has('json');
  const [first] = parsed.positionals;
  switch (command) {
    case 'list': {
      const rows = PREDICATES.map(({ id, kind }) => ({ id, kind }));
      return {
        code: 0,
        output: json
          ? JSON.stringify(rows)
          : rows.map((row) => `${row.id} (${row.kind})`).join('\n'),
      };
    }
    case 'shadow': {
      if (first === undefined || parsed.positionals.length > 1)
        throw new UsageError('Usage: jev-predicates.ts shadow <predicate> --evidence-file <json>');
      if (findPredicate(first) === undefined) throw new UsageError(`Unknown predicate "${first}".`);
      const entry = await shadow(first, readEvidence(parsed.values['evidence-file']), dependencies);
      return {
        code: 0,
        output: json
          ? JSON.stringify(entry)
          : `${entry.id} ${entry.predicate} ${entry.outcome} decision=${entry.decision ?? 'none'} ` +
            `confidence=${entry.confidence === null ? 'n/a' : entry.confidence.toFixed(2)} ` +
            `latency=${entry.latencyMs}ms${entry.logged ? '' : '\nWARNING: the shadow log could not be written.'}`,
      };
    }
    case 'outcome': {
      const actual = parsed.values['actual'];
      if (first === undefined || parsed.positionals.length > 1 || !actual)
        throw new UsageError('Usage: jev-predicates.ts outcome <id> --actual <value>');
      let recorded: boolean;
      try {
        recorded = recordOutcome(first, actual, dependencies);
      } catch (error) {
        return {
          code: 1,
          output: `The outcome was not recorded: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return recorded
        ? {
            code: 0,
            output: json ? JSON.stringify({ id: first, actual }) : `Recorded ${first}: ${actual}`,
          }
        : { code: 1, output: `No shadow record has id ${first}.` };
    }
    case 'report': {
      const rows = report(logPathOf(dependencies));
      return { code: 0, output: json ? JSON.stringify(rows) : renderReport(rows) };
    }
    default:
      throw new UsageError('Usage: jev-predicates.ts list|shadow|outcome|report ...');
  }
}

if (import.meta.main) {
  try {
    const { code, output } = await run(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
