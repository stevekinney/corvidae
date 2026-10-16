/**
 * The reference policy: the model every baseline shares in the offline lanes
 * (COR-755, "equal model"). It is a fixture, not a claim about any real
 * model, and it is deliberately ordinary: it looks the task up in memory
 * once, reads the recalled records the way a careful reader would, and acts.
 *
 * 1. With no tool result yet, it calls `memory_recall` with the prompt's
 *    lookup.
 * 2. With the recall's records, it keeps the ones whose first sentence states
 *    the slot the task needs (`parseStatement`). It trusts an operator record
 *    over the customer's own words, and those over a tool result or
 *    ingested document (`SOURCE_RANK`), and among equals takes the newest.
 *    It calls `environment_action` with that value, or `environment_unknown`
 *    when no record states the slot. It never reads instructions in a record
 *    as instructions, but it has no way to tell a poisoned statement from a
 *    true one: that is memory's job.
 * 3. After the environment answers, it stops.
 *
 * The sampled variant differs in one way: with probability `noise`, drawn
 * from a generator seeded by the trial's seed, it takes any stating record
 * at random instead of the reference choice. Its trials therefore vary, and
 * each one replays exactly from its seed or from its recorded replies.
 *
 * Usage is counted with the envelope's token estimate, so cost is
 * deterministic too.
 */
import type {
  GenerateContext,
  GenerateFunction,
  GenerateResponse,
  JSONValue,
} from '@lostgradient/operative';

import { SOURCE_RANK } from './baselines/adapter';
import { type ComputeEnvelope, estimateTokens } from './envelope';
import { readTaskPrompt } from './prompt';
import { EVIDENCE_SOURCES } from './scenarios';
import { normalizeSlot, parseStatement } from './statements';

/** One record as `memory_recall` returns it to the model. */
export interface RecallToolRecord {
  readonly content: string;
  readonly observedAt: string | null;
  readonly source: string | null;
}

/** What `memory_recall` returns to the model. */
export interface RecallToolResult {
  readonly found: boolean;
  readonly records: readonly RecallToolRecord[];
  readonly withheld: number;
  /** Records the context-token budget left out. */
  readonly truncated: number;
}

interface Message {
  readonly role: string;
  readonly content: unknown;
  readonly toolResult?: { readonly content: JSONValue } | undefined;
}

function messagesOf(context: GenerateContext): Message[] {
  const history = context.conversation.current;
  return history.ids.map((id) => history.messages[id]!);
}

function textOf(message: Message): string {
  if (message.toolResult !== undefined) return JSON.stringify(message.toolResult.content);
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

/** A 32-bit mulberry generator: the sampled policy's only source of variation. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function isRecallResult(value: unknown): value is RecallToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { records?: unknown }).records)
  );
}

function rankOf(source: string | null): number {
  const known = EVIDENCE_SOURCES.find((entry) => entry === source);
  return known === undefined ? 0 : SOURCE_RANK[known];
}

function timeOf(record: RecallToolRecord): number {
  return record.observedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(record.observedAt);
}

/**
 * The reference choice among recalled records for `slot`: the value of the
 * best-ranked source's newest statement, or `undefined` when none states it.
 * Records keep their recall order among exact ties.
 */
export function chooseStatement(
  records: readonly RecallToolRecord[],
  slot: string,
  sample?: () => number,
  noise = 0,
): string | undefined {
  const wanted = normalizeSlot(slot);
  const stating = records.flatMap((record) => {
    const statement = parseStatement(record.content);
    return statement?.slot === wanted ? [{ record, value: statement.value }] : [];
  });
  if (stating.length === 0) return undefined;
  if (sample !== undefined && sample() < noise) {
    return stating[Math.floor(sample() * stating.length)]!.value;
  }
  const best = stating.reduce((chosen, candidate) => {
    const rank = rankOf(candidate.record.source) - rankOf(chosen.record.source);
    if (rank !== 0) return rank > 0 ? candidate : chosen;
    return timeOf(candidate.record) > timeOf(chosen.record) ? candidate : chosen;
  });
  return best.value;
}

function respond(
  messages: readonly Message[],
  content: string,
  toolCalls: GenerateResponse['toolCalls'],
): GenerateResponse {
  const prompt = estimateTokens(messages.map(textOf).join('\n'));
  const completion = estimateTokens(content + JSON.stringify(toolCalls));
  return {
    content,
    toolCalls,
    usage: { prompt, completion, total: prompt + completion },
  };
}

/** The reference policy under `envelope`, seeded by `seed` when the envelope's model samples. */
export function createReferencePolicy(envelope: ComputeEnvelope, seed: number): GenerateFunction {
  const sample = envelope.model.noise > 0 ? seededRandom(seed) : undefined;
  return (context) => {
    const messages = messagesOf(context);
    const prompt = messages.find((message) => message.role === 'user');
    const task = readTaskPrompt(typeof prompt?.content === 'string' ? prompt.content : '');
    if (task === undefined) {
      return Promise.resolve(respond(messages, 'I cannot read this task.', []));
    }
    const results = messages.filter((message) => message.role === 'tool-result');
    const id = `call-${context.step}`;
    if (results.length === 0) {
      return Promise.resolve(
        respond(messages, '', [{ id, name: 'memory_recall', arguments: { query: task.query } }]),
      );
    }
    if (results.length > 1) return Promise.resolve(respond(messages, 'Done.', []));
    const recalled = results[0]!.toolResult?.content;
    const records = isRecallResult(recalled) ? recalled.records : [];
    const value = chooseStatement(records, task.slot, sample, envelope.model.noise);
    const call =
      value === undefined
        ? { id, name: 'environment_unknown', arguments: { action: task.action } }
        : { id, name: 'environment_action', arguments: { action: task.action, value } };
    return Promise.resolve(respond(messages, '', [call]));
  };
}
