#!/usr/bin/env bun
// Chef transcript usage: sums the token usage of every model call in Claude Code and Codex
// session transcripts, so a run can measure where its spend goes instead of guessing. It reports
// tokens, context size per call, and full-context cache rewrites (a call that rewrote more of its
// context than it read from cache, which is what a long wait in a large context costs). It prints
// dollars only from a price table the caller supplies; it never assumes prices.
//
// Usage:
//   bun scripts/chef/transcript-usage.ts [--json] [--prices <json>] [--rewrite-floor <tokens>] <path>...
//
// A path is a Claude Code transcript (`.jsonl`), a Codex session log (`rollout-*.jsonl`), or a
// directory searched recursively for either (a Claude Code session's `subagents/` directory, for
// example). A Claude Code subagent's `.meta.json` description, when present, labels its transcript.
// A price table maps a model to dollars per million tokens:
//   { "<model>": { "input": 4, "output": 20, "cacheRead": 0.4, "cacheWrite": 5 } }
//
// Exit codes: 0 report written, 1 no readable transcript found, 2 invalid CLI usage.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export type Provider = 'claude-code' | 'codex';

export interface ModelCall {
  model: string;
  uncachedInput: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  timestamp: string | undefined;
  /** Tool calls the model made in this call; `undefined` where the transcript does not say. */
  toolCalls: number | undefined;
}

export interface TranscriptUsage {
  path: string;
  provider: Provider;
  label: string;
  calls: ModelCall[];
}

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One model's share of a transcript's calls. */
export interface ModelTotals {
  calls: number;
  uncachedInput: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface TranscriptReport {
  path: string;
  provider: Provider;
  label: string;
  models: string[];
  byModel: Record<string, ModelTotals>;
  calls: number;
  uncachedInput: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  toolCalls: number | undefined;
  meanContext: number;
  maxContext: number;
  lastContext: number;
  rewrites: number;
  rewriteTokens: number;
  rewriteGapsMinutes: number[];
  cost: number | undefined;
}

export class UsageError extends Error {}

/** The tokens a call's context held: everything it read, cached or not. */
export function contextOf(call: ModelCall): number {
  return call.uncachedInput + call.cacheWrite + call.cacheRead;
}

function numberAt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseLines(text: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object')
        entries.push(parsed as Record<string, unknown>);
    } catch {
      // A truncated last line (a transcript still being written) is skipped, not fatal.
    }
  }
  return entries;
}

/** Which provider wrote `entries`, or `undefined` when neither format is recognized. */
export function detectProvider(entries: Record<string, unknown>[]): Provider | undefined {
  for (const entry of entries.slice(0, 50)) {
    if (
      entry['type'] === 'session_meta' ||
      entry['type'] === 'event_msg' ||
      entry['type'] === 'turn_context'
    )
      return 'codex';
    if (
      (entry['type'] === 'assistant' || entry['type'] === 'user') &&
      typeof entry['message'] === 'object'
    )
      return 'claude-code';
  }
  return undefined;
}

/**
 * Claude Code writes each content block of one model response as its own entry, all carrying the
 * same message id and usage, so calls are keyed by message id and tool-use blocks by their own id.
 */
export function claudeCodeCalls(entries: Record<string, unknown>[]): ModelCall[] {
  const calls = new Map<string, ModelCall>();
  const toolIds = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry['type'] !== 'assistant') continue;
    const message = entry['message'] as Record<string, unknown> | undefined;
    const usage = message?.['usage'] as Record<string, unknown> | undefined;
    const id = message?.['id'];
    if (usage === undefined || typeof id !== 'string') continue;
    // Claude Code writes `<synthetic>` entries for messages no model produced (an interrupted
    // turn, for example); they carry no usage and are not calls.
    if (message?.['model'] === '<synthetic>') continue;
    const tools = toolIds.get(id) ?? new Set<string>();
    for (const block of Array.isArray(message?.['content'])
      ? (message['content'] as unknown[])
      : []) {
      const content = block as Record<string, unknown> | null;
      if (content?.['type'] === 'tool_use')
        tools.add(typeof content['id'] === 'string' ? content['id'] : String(tools.size));
    }
    toolIds.set(id, tools);
    calls.set(id, {
      model: typeof message?.['model'] === 'string' ? message['model'] : 'unknown',
      uncachedInput: numberAt(usage['input_tokens']),
      cacheWrite: numberAt(usage['cache_creation_input_tokens']),
      cacheRead: numberAt(usage['cache_read_input_tokens']),
      output: numberAt(usage['output_tokens']),
      timestamp: typeof entry['timestamp'] === 'string' ? entry['timestamp'] : undefined,
      toolCalls: tools.size,
    });
  }
  return [...calls.values()];
}

/**
 * Codex logs a `token_count` event per model call with that call's usage in `last_token_usage`.
 * Its `input_tokens` includes the cached tokens. An event whose running total did not grow repeats
 * an earlier call (a rate-limit refresh, for example) and is skipped.
 */
export function codexCalls(entries: Record<string, unknown>[]): ModelCall[] {
  const calls: ModelCall[] = [];
  let model = 'unknown';
  let lastTotal = -1;
  for (const entry of entries) {
    const payload = entry['payload'] as Record<string, unknown> | undefined;
    if (entry['type'] === 'turn_context' && typeof payload?.['model'] === 'string')
      model = payload['model'];
    if (entry['type'] !== 'event_msg' || payload?.['type'] !== 'token_count') continue;
    const info = payload['info'] as Record<string, unknown> | null | undefined;
    const last = info?.['last_token_usage'] as Record<string, unknown> | undefined;
    const total = numberAt(
      (info?.['total_token_usage'] as Record<string, unknown> | undefined)?.['total_tokens'],
    );
    if (last === undefined || total <= lastTotal) continue;
    lastTotal = total;
    const cached = numberAt(last['cached_input_tokens']);
    calls.push({
      model,
      uncachedInput: Math.max(0, numberAt(last['input_tokens']) - cached),
      cacheWrite: numberAt(last['cache_write_input_tokens']),
      cacheRead: cached,
      output: numberAt(last['output_tokens']),
      timestamp: typeof entry['timestamp'] === 'string' ? entry['timestamp'] : undefined,
      toolCalls: undefined,
    });
  }
  return calls;
}

function labelFor(path: string): string {
  const meta = path.replace(/\.jsonl$/, '.meta.json');
  if (meta !== path && existsSync(meta)) {
    try {
      const parsed = JSON.parse(readFileSync(meta, 'utf8')) as Record<string, unknown>;
      if (typeof parsed['description'] === 'string' && parsed['description'] !== '')
        return parsed['description'];
    } catch {
      // An unreadable sidecar leaves the file name as the label.
    }
  }
  return basename(path);
}

/** Read one transcript file, or `undefined` when it is neither provider's format. */
export function readTranscript(path: string): TranscriptUsage | undefined {
  const entries = parseLines(readFileSync(path, 'utf8'));
  const provider = detectProvider(entries);
  if (provider === undefined) return undefined;
  const calls = provider === 'codex' ? codexCalls(entries) : claudeCodeCalls(entries);
  return { path, provider, label: labelFor(path), calls };
}

/** Every `.jsonl` file under `path`, or `path` itself when it is a file. */
export function transcriptFiles(path: string): string[] {
  if (!existsSync(path)) throw new UsageError(`No such path: ${path}`);
  if (!statSync(path).isDirectory()) return [path];
  const found: string[] = [];
  for (const name of readdirSync(path).toSorted()) {
    const child = join(path, name);
    if (statSync(child).isDirectory()) found.push(...transcriptFiles(child));
    else if (name.endsWith('.jsonl')) found.push(child);
  }
  return found;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

export function costOf(
  call: ModelCall,
  prices: Record<string, Price> | undefined,
): number | undefined {
  const price = prices?.[call.model];
  if (price === undefined) return undefined;
  return (
    (call.uncachedInput * price.input +
      call.cacheWrite * price.cacheWrite +
      call.cacheRead * price.cacheRead +
      call.output * price.output) /
    1_000_000
  );
}

/**
 * Summarize one transcript. A rewrite is a call after the first that wrote at least `rewriteFloor`
 * tokens to cache and more than it read from it: its cached context had expired, so it paid to
 * write the context again.
 */
export function report(
  usage: TranscriptUsage,
  prices: Record<string, Price> | undefined,
  rewriteFloor = 50_000,
): TranscriptReport {
  const contexts = usage.calls.map(contextOf);
  const gaps: number[] = [];
  let rewrites = 0;
  let rewriteTokens = 0;
  usage.calls.forEach((call, index) => {
    if (index === 0 || call.cacheWrite < rewriteFloor || call.cacheWrite <= call.cacheRead) return;
    rewrites += 1;
    rewriteTokens += call.cacheWrite;
    const previous = usage.calls[index - 1]?.timestamp;
    if (previous !== undefined && call.timestamp !== undefined) {
      gaps.push((Date.parse(call.timestamp) - Date.parse(previous)) / 60_000);
    }
  });
  const costs = usage.calls.map((call) => costOf(call, prices));
  const priced = prices !== undefined && costs.every((cost) => cost !== undefined);
  const sum = (pick: (call: ModelCall) => number) =>
    usage.calls.reduce((total, call) => total + pick(call), 0);
  const byModel: Record<string, ModelTotals> = {};
  for (const call of usage.calls) {
    const totals = (byModel[call.model] ??= {
      calls: 0,
      uncachedInput: 0,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
    });
    totals.calls += 1;
    totals.uncachedInput += call.uncachedInput;
    totals.cacheWrite += call.cacheWrite;
    totals.cacheRead += call.cacheRead;
    totals.output += call.output;
  }
  return {
    path: usage.path,
    provider: usage.provider,
    label: usage.label,
    models: Object.keys(byModel).toSorted(),
    byModel,
    calls: usage.calls.length,
    uncachedInput: sum((call) => call.uncachedInput),
    cacheWrite: sum((call) => call.cacheWrite),
    cacheRead: sum((call) => call.cacheRead),
    output: sum((call) => call.output),
    toolCalls: usage.provider === 'codex' ? undefined : sum((call) => call.toolCalls ?? 0),
    meanContext:
      contexts.length === 0 ? 0 : Math.round(contexts.reduce((a, b) => a + b, 0) / contexts.length),
    maxContext: contexts.length === 0 ? 0 : Math.max(...contexts),
    lastContext: contexts.at(-1) ?? 0,
    rewrites,
    rewriteTokens,
    rewriteGapsMinutes: gaps,
    cost: priced ? costs.reduce<number>((total, cost) => total + (cost ?? 0), 0) : undefined,
  };
}

function readPrices(path: string): Record<string, Price> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new UsageError(`Could not read the price table ${path}: ${String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object')
    throw new UsageError('A price table is a JSON object.');
  for (const [model, price] of Object.entries(parsed as Record<string, unknown>)) {
    const fields = price as Record<string, unknown>;
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      if (typeof fields?.[field] !== 'number')
        throw new UsageError(`Price for ${model} needs a numeric ${field}.`);
    }
  }
  return parsed as Record<string, Price>;
}

function format(value: number): string {
  return value.toLocaleString('en-US');
}

function renderText(reports: TranscriptReport[]): string {
  const lines: string[] = [];
  const totals = new Map<string, ModelTotals>();
  for (const item of reports) {
    for (const [model, sums] of Object.entries(item.byModel)) {
      const key = `${item.provider} ${model}`;
      const total = totals.get(key) ?? {
        calls: 0,
        uncachedInput: 0,
        cacheWrite: 0,
        cacheRead: 0,
        output: 0,
      };
      total.calls += sums.calls;
      total.uncachedInput += sums.uncachedInput;
      total.cacheWrite += sums.cacheWrite;
      total.cacheRead += sums.cacheRead;
      total.output += sums.output;
      totals.set(key, total);
    }
  }
  lines.push('Totals by provider and model:');
  for (const [key, t] of [...totals].toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    lines.push(
      `  ${key}: calls=${format(t.calls)} uncached=${format(t.uncachedInput)} cacheWrite=${format(t.cacheWrite)} cacheRead=${format(t.cacheRead)} output=${format(t.output)}`,
    );
  }
  const gaps = reports.flatMap((item) => item.rewriteGapsMinutes);
  const rewrites = reports.reduce((total, item) => total + item.rewrites, 0);
  lines.push(
    `Full-context rewrites: ${format(rewrites)} calls, ${format(reports.reduce((t, item) => t + item.rewriteTokens, 0))} tokens; median gap before one ${median(gaps).toFixed(1)} min.`,
  );
  const costs = reports.map((item) => item.cost);
  if (costs.some((cost) => cost !== undefined)) {
    const unpriced = reports.filter((item) => item.cost === undefined).length;
    lines.push(
      `Cost from the supplied price table: $${costs.reduce<number>((t, c) => t + (c ?? 0), 0).toFixed(2)}${unpriced > 0 ? ` (${unpriced} transcripts had an unpriced model)` : ''}.`,
    );
  }
  lines.push('Transcripts by tokens processed (input, cache write and cache read):');
  const processed = (item: TranscriptReport) =>
    item.uncachedInput + item.cacheWrite + item.cacheRead;
  for (const item of [...reports].toSorted((a, b) => processed(b) - processed(a)).slice(0, 25)) {
    lines.push(
      `  ${format(processed(item)).padStart(15)}  calls=${String(item.calls).padStart(5)} meanCtx=${format(item.meanContext)} maxCtx=${format(item.maxContext)} lastCtx=${format(item.lastContext)} rewrites=${item.rewrites}  ${item.label}`,
    );
  }
  return lines.join('\n');
}

export function run(argv: string[]): { code: number; output: string } {
  let json = false;
  let prices: Record<string, Price> | undefined;
  let rewriteFloor = 50_000;
  const paths: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--json') json = true;
    else if (argument === '--prices') prices = readPrices(argv[(index += 1)] ?? '');
    else if (argument === '--rewrite-floor') {
      rewriteFloor = Number(argv[(index += 1)]);
      if (!Number.isInteger(rewriteFloor) || rewriteFloor < 0)
        throw new UsageError('--rewrite-floor takes a whole number of tokens.');
    } else if (argument.startsWith('--')) throw new UsageError(`Unknown option ${argument}.`);
    else paths.push(argument);
  }
  if (paths.length === 0) throw new UsageError('Name at least one transcript file or directory.');
  const reports = paths
    .flatMap(transcriptFiles)
    .map(readTranscript)
    .filter((usage): usage is TranscriptUsage => usage !== undefined && usage.calls.length > 0)
    .map((usage) => report(usage, prices, rewriteFloor));
  if (reports.length === 0)
    return {
      code: 1,
      output: 'No Claude Code or Codex transcript with model calls was found.',
    };
  return {
    code: 0,
    output: json ? JSON.stringify(reports, null, 2) : renderText(reports),
  };
}

if (import.meta.main) {
  try {
    const { code, output } = run(Bun.argv.slice(2));
    (code === 0 ? process.stdout : process.stderr).write(`${output}\n`);
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
