#!/usr/bin/env bun
// Chef Jev: asks TypeSafe AI's Jev decision model one yes/no, choice or scale question and reports
// the answer with its probability against a threshold. Jev returns probabilities, not text. A
// coordinator uses it to settle a routine call, or an owner decision, without interrupting the
// owner when the model is sure enough (see "Decisions and Jev" in the chef skill).
//
// Usage:
//   bun scripts/chef/jev.ts decide --question <text> (--state <text> | --state-file <path>)
//        (--yes-no | --choice <key>=<description> ... | --scale <level>,<level>,...)
//        [--threshold <p>] [--kind routine|owner] [--record <jsonl>] [--json]
//
// Thresholds: 0.85 for `--kind routine` (the default), 0.9 for `--kind owner`; `--threshold` may
// raise either for one call and is a usage error (exit 2) below the kind's default. For a yes/no question the answer is the likelier side, and its probability is
// that side's: P(yes) of 0.04 is a "no" at 0.96. For a scale question the answer is the level
// nearest Jev's score, and its probability is that level's.
//
// The request is `POST https://api.typesafe.ai/v1/systemone` with a bearer key
// (`TYPESAFE_API_KEY`, found by credentials.ts) and `{ state, model: "jev-latest", questions:
// { decision: ... } }`. Wire types, confirmed against @tanstack/ai-typesafe 1.0.0 and live calls:
// yes/no is `{ type: "noul", instructions }` answered `{ type: "noul", noul: P(yes) }`; a choice is
// `{ type: "choice", instructions, criteria: { key: description } }` answered `{ type: "choice",
// choice, probabilities, confidence }`; a scale is `{ type: "score", instructions, criteria:
// [levels] }` answered `{ type: "score", score, probabilities: { "0": p, ... }, confidence, legend }`.
//
// Every call is appended to a JSONL record, `<main checkout>/tmp/chef/jev-decisions.jsonl` by
// default: timestamp, kind, question, options, answer, probability, model, threshold, outcome, and
// a SHA-256 of the state, never the state itself. The key is never printed or recorded.
//
// Exit codes: 0 decided at or above the threshold, 1 below the threshold, 2 invalid usage,
// 3 Jev unavailable (no credential, a 401, a 5xx or 529, a network error, or an unusable answer;
// a 429 is retried once after the wait the response asks for).

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveCredential } from './credentials.ts';
import { emitResult, parseOptions, UsageError } from './process-runner.ts';
import { resolveMainCheckout } from './repository-locations.ts';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';
export const ROUTINE_THRESHOLD = 0.85;
export const OWNER_THRESHOLD = 0.9;
const REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const DEFAULT_RETRY_SECONDS = 1;
const MAXIMUM_RETRY_SECONDS = 120;
const QUESTION_KEY = 'decision';

export type Kind = 'routine' | 'owner';
export type Mode =
  | { type: 'yes-no' }
  | { type: 'choice'; options: Record<string, string | null> }
  | { type: 'scale'; levels: string[] };

export interface DecideOptions {
  question: string;
  state: string;
  mode: Mode;
  kind: Kind;
  threshold: number;
  /** The JSONL record to append to; `null` writes none. */
  record: string | null;
}

export type Outcome = 'decided' | 'below-threshold' | 'unavailable';

export interface Decision {
  outcome: Outcome;
  answer: string | null;
  probability: number | null;
  probabilities: Record<string, number> | null;
  model: string | null;
  threshold: number;
  kind: Kind;
  /** Why Jev was unavailable; never contains the key. */
  reason: string | null;
  /** Where the call was recorded, or why it was not. */
  recorded: string | null;
  recordWarning: string | null;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface JevDependencies {
  fetch: FetchLike;
  /** Waits out a 429; tests pass a recorder. */
  sleep: (milliseconds: number) => Promise<void>;
  now: () => Date;
  resolveKey: () => string | undefined;
  /** The main checkout, for the default record path. */
  mainCheckout: () => string;
}

export function defaultJevDependencies(): JevDependencies {
  return {
    fetch: (url, init) => fetch(url, init),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: () => new Date(),
    resolveKey: () => resolveCredential('TYPESAFE_API_KEY').value,
    mainCheckout: () => resolveMainCheckout(),
  };
}

// Parsing ------------------------------------------------------------------------------------

/** Parse `--choice key=description` values; a key with no description is sent as `null`. */
export function parseChoices(values: string[]): Record<string, string | null> {
  const options: Record<string, string | null> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    const key = (separator === -1 ? value : value.slice(0, separator)).trim();
    const description = separator === -1 ? '' : value.slice(separator + 1).trim();
    if (key === '') throw new UsageError(`--choice "${value}" needs a key before the "=".`);
    if (Object.hasOwn(options, key)) throw new UsageError(`--choice key "${key}" is repeated.`);
    options[key] = description === '' ? null : description;
  }
  if (Object.keys(options).length < 2) throw new UsageError('--choice needs at least two options.');
  return options;
}

/** Parse `--scale a,b,c`: ordered levels, lowest first, at least two, none repeated. */
export function parseScale(value: string): string[] {
  const levels = value.split(',').map((level) => level.trim());
  if (levels.some((level) => level === '')) throw new UsageError('--scale has an empty level.');
  if (levels.length < 2) throw new UsageError('--scale needs at least two levels.');
  if (new Set(levels).size !== levels.length) throw new UsageError('--scale repeats a level.');
  return levels;
}

export function parseThreshold(value: string): number {
  const threshold = Number(value);
  if (value.trim() === '' || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1)
    throw new UsageError(`--threshold "${value}" must be a probability above 0 and at most 1.`);
  return threshold;
}

export function defaultThreshold(kind: Kind): number {
  return kind === 'owner' ? OWNER_THRESHOLD : ROUTINE_THRESHOLD;
}

// Wire ---------------------------------------------------------------------------------------

export function buildQuestion(question: string, mode: Mode): Record<string, unknown> {
  switch (mode.type) {
    case 'yes-no':
      return { type: 'noul', instructions: question };
    case 'choice':
      return { type: 'choice', instructions: question, criteria: mode.options };
    case 'scale':
      return { type: 'score', instructions: question, criteria: mode.levels };
  }
}

export interface Interpreted {
  answer: string;
  probability: number;
  probabilities: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function probabilityOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

/** Turn one wire answer into the answer, its probability and every option's probability. */
export function interpretAnswer(mode: Mode, wire: unknown): Interpreted | string {
  if (!isRecord(wire)) return 'the answer is not an object';
  if (mode.type === 'yes-no') {
    const yes = wire['type'] === 'noul' ? probabilityOf(wire['noul']) : undefined;
    if (yes === undefined) return 'the yes/no answer has no probability';
    const answer = yes >= 0.5 ? 'yes' : 'no';
    return {
      answer,
      probability: answer === 'yes' ? yes : 1 - yes,
      probabilities: { yes, no: 1 - yes },
    };
  }
  if (mode.type === 'choice') {
    const choice = wire['type'] === 'choice' ? wire['choice'] : undefined;
    if (typeof choice !== 'string' || !Object.hasOwn(mode.options, choice))
      return 'the choice answer names no option that was offered';
    if (!isRecord(wire['probabilities'])) return 'the choice answer has no probabilities';
    const probabilities: Record<string, number> = {};
    for (const key of Object.keys(mode.options)) {
      const probability = probabilityOf(wire['probabilities'][key]);
      if (probability === undefined) return `the choice answer has no probability for "${key}"`;
      probabilities[key] = probability;
    }
    return { answer: choice, probability: probabilities[choice] ?? 0, probabilities };
  }
  const score = wire['type'] === 'score' ? wire['score'] : undefined;
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'the scale answer has no score';
  if (!isRecord(wire['probabilities'])) return 'the scale answer has no probabilities';
  const lastIndex = mode.levels.length - 1;
  const index = Math.min(Math.max(Math.round(score), 0), lastIndex);
  const probabilities: Record<string, number> = {};
  for (const [position, level] of mode.levels.entries()) {
    const probability = probabilityOf(wire['probabilities'][String(position)]);
    if (probability === undefined)
      return `the scale answer has no probability for level "${level}"`;
    probabilities[level] = probability;
  }
  const answer = mode.levels[index] ?? '';
  return { answer, probability: probabilities[answer] ?? 0, probabilities };
}

// Request ------------------------------------------------------------------------------------

/** Seconds a 429 asks us to wait: `Retry-After` as seconds or an HTTP date, clamped. */
export function retryDelaySeconds(header: string | null, now: Date): number {
  if (header === null || header.trim() === '') return DEFAULT_RETRY_SECONDS;
  const seconds = Number(header);
  const asked = Number.isFinite(seconds) ? seconds : (Date.parse(header) - now.getTime()) / 1000;
  if (!Number.isFinite(asked)) return DEFAULT_RETRY_SECONDS;
  return Math.min(Math.max(asked, 0), MAXIMUM_RETRY_SECONDS);
}

type Exchange = { ok: true; model: string; wire: unknown } | { ok: false; reason: string };

async function exchange(
  options: DecideOptions,
  key: string,
  dependencies: JevDependencies,
): Promise<Exchange> {
  const body = JSON.stringify({
    state: options.state,
    model: JEV_MODEL,
    questions: { [QUESTION_KEY]: buildQuestion(options.question, options.mode) },
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await dependencies.fetch(JEV_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
      });
    } catch (error) {
      // The message of a network error never carries the key, but keep to its name to be safe.
      return {
        ok: false,
        reason: `network error (${error instanceof Error ? error.name : 'unknown'})`,
      };
    }
    if (response.status === 429) {
      if (attempt === 0) {
        await dependencies.sleep(
          retryDelaySeconds(response.headers.get('retry-after'), dependencies.now()) * 1000,
        );
        continue;
      }
      return { ok: false, reason: 'HTTP 429 after one retry' };
    }
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, reason: 'the response is not JSON' };
    }
    if (!isRecord(json) || typeof json['model'] !== 'string' || !isRecord(json['answers']))
      return { ok: false, reason: 'the response has an unexpected shape' };
    if (json['answers'][QUESTION_KEY] === undefined)
      return { ok: false, reason: 'Jev declined to answer the question' };
    return { ok: true, model: json['model'], wire: json['answers'][QUESTION_KEY] };
  }
  return { ok: false, reason: 'HTTP 429 after one retry' };
}

// Record -------------------------------------------------------------------------------------

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function describeOptions(mode: Mode): unknown {
  if (mode.type === 'yes-no') return ['yes', 'no'];
  return mode.type === 'choice' ? mode.options : mode.levels;
}

function appendRecord(
  path: string,
  options: DecideOptions,
  decision: Decision,
  now: Date,
): string | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const entry = {
      timestamp: now.toISOString(),
      kind: options.kind,
      question: options.question,
      options: describeOptions(options.mode),
      answer: decision.answer,
      probability: decision.probability,
      model: decision.model,
      threshold: decision.threshold,
      outcome: decision.outcome,
      reason: decision.reason,
      stateSha256: sha256(options.state),
    };
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    return undefined;
  } catch (error) {
    return `the decision was not recorded at ${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// Decide -------------------------------------------------------------------------------------

/** Ask Jev. Never throws for an unavailable Jev; the outcome says so. */
export async function decide(
  options: DecideOptions,
  partial: Partial<JevDependencies> = {},
): Promise<Decision> {
  const dependencies = { ...defaultJevDependencies(), ...partial };
  const decision: Decision = {
    outcome: 'unavailable',
    answer: null,
    probability: null,
    probabilities: null,
    model: null,
    threshold: options.threshold,
    kind: options.kind,
    reason: null,
    recorded: null,
    recordWarning: null,
  };
  const key = dependencies.resolveKey();
  if (key === undefined || key === '') {
    decision.reason = 'no TYPESAFE_API_KEY (environment, Keychain or .env)';
  } else {
    const result = await exchange(options, key, dependencies);
    if (!result.ok) {
      decision.reason = result.reason;
    } else {
      const interpreted = interpretAnswer(options.mode, result.wire);
      decision.model = result.model;
      if (typeof interpreted === 'string') {
        decision.reason = interpreted;
      } else {
        decision.answer = interpreted.answer;
        decision.probability = interpreted.probability;
        decision.probabilities = interpreted.probabilities;
        decision.outcome =
          interpreted.probability >= options.threshold ? 'decided' : 'below-threshold';
      }
    }
  }
  if (options.record !== null) {
    const warning = appendRecord(options.record, options, decision, dependencies.now());
    if (warning === undefined) decision.recorded = options.record;
    else decision.recordWarning = warning;
  }
  return decision;
}

function percent(probability: number): string {
  return probability.toFixed(2);
}

export function renderDecision(decision: Decision): string {
  if (decision.outcome === 'unavailable')
    return `Jev unavailable: ${decision.reason ?? 'unknown reason'}.${warningLine(decision)}`;
  const spread = Object.entries(decision.probabilities ?? {})
    .map(([name, probability]) => `${name}=${percent(probability)}`)
    .join(' ');
  return (
    [
      `${decision.outcome === 'decided' ? 'DECIDED' : 'BELOW THRESHOLD'}: ${decision.answer} (p=${percent(decision.probability ?? 0)}) ` +
        `model=${decision.model} threshold=${percent(decision.threshold)} kind=${decision.kind}`,
      `probabilities: ${spread}`,
    ].join('\n') + warningLine(decision)
  );
}

function warningLine(decision: Decision): string {
  return decision.recordWarning === null ? '' : `\nWARNING: ${decision.recordWarning}`;
}

export async function run(
  argv: string[],
  partial: Partial<JevDependencies> = {},
): Promise<{ code: number; output: string }> {
  const [command, ...rest] = argv;
  if (command !== 'decide') throw new UsageError('Usage: jev.ts decide --question <text> ...');
  const parsed = parseOptions(rest, {
    values: ['question', 'state', 'state-file', 'scale', 'threshold', 'kind', 'record'],
    repeated: ['choice'],
    flags: ['yes-no', 'json'],
  });
  if (parsed.positionals.length > 0)
    throw new UsageError(`Unexpected argument ${parsed.positionals[0]}.`);
  const question = parsed.values['question']?.trim() ?? '';
  if (question === '') throw new UsageError('--question is required.');

  const kind = parsed.values['kind'] ?? 'routine';
  if (kind !== 'routine' && kind !== 'owner')
    throw new UsageError('--kind must be routine or owner.');
  const threshold =
    parsed.values['threshold'] === undefined
      ? defaultThreshold(kind)
      : parseThreshold(parsed.values['threshold']);
  if (threshold < defaultThreshold(kind))
    throw new UsageError(
      `--threshold ${threshold} is below the ${defaultThreshold(kind)} default for --kind ${kind}; a call may raise the threshold, never lower it.`,
    );

  const modes = [
    parsed.flags.has('yes-no'),
    (parsed.repeated['choice']?.length ?? 0) > 0,
    parsed.values['scale'] !== undefined,
  ].filter(Boolean).length;
  if (modes !== 1) throw new UsageError('Name exactly one of --yes-no, --choice or --scale.');
  const mode: Mode = parsed.flags.has('yes-no')
    ? { type: 'yes-no' }
    : parsed.values['scale'] === undefined
      ? { type: 'choice', options: parseChoices(parsed.repeated['choice'] ?? []) }
      : { type: 'scale', levels: parseScale(parsed.values['scale']) };

  if ((parsed.values['state'] === undefined) === (parsed.values['state-file'] === undefined))
    throw new UsageError('Name exactly one of --state or --state-file.');
  let state = parsed.values['state'] ?? '';
  if (parsed.values['state-file'] !== undefined) {
    const path = parsed.values['state-file'];
    if (!existsSync(path)) throw new UsageError(`No such state file: ${path}`);
    state = readFileSync(path, 'utf8');
  }
  if (state.trim() === '') throw new UsageError('The state is empty.');

  let record: string | null;
  if (parsed.values['record'] !== undefined) record = parsed.values['record'];
  else {
    try {
      const dependencies = { ...defaultJevDependencies(), ...partial };
      record = join(dependencies.mainCheckout(), 'tmp', 'chef', 'jev-decisions.jsonl');
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      record = null;
    }
  }
  const decision = await decide({ question, state, mode, kind, threshold, record }, partial);
  const code = decision.outcome === 'decided' ? 0 : decision.outcome === 'below-threshold' ? 1 : 3;
  return {
    code,
    output: parsed.flags.has('json')
      ? JSON.stringify({ ...decision, cleared: decision.outcome === 'decided' })
      : record === null && parsed.values['record'] === undefined
        ? `${renderDecision(decision)}\nWARNING: not in a Git repository, so no record was written; pass --record.`
        : renderDecision(decision),
  };
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
