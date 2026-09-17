import type { ServerResponse } from 'node:http';

import {
  APPROVAL_FOLLOW_UP_TEXT,
  APPROVAL_LONG_NOTE_TEXT,
  APPROVAL_NOTE_TEXT,
  DEFAULT_REPLY_TEXT,
  GATED_FIRST_CHUNK,
  GATED_SECOND_CHUNK,
  HOLD_PARTIAL_TEXT,
  MIDSTREAM_ERROR_MESSAGE,
  MIDSTREAM_PARTIAL_TEXT,
  STEPPED_CHUNKS,
  TOOL_ARGUMENTS_FIRST_HALF,
  TOOL_ARGUMENTS_SECOND_HALF,
  TOOL_CALL_NAME,
  TOOL_FOLLOW_UP_TEXT,
  type FixtureScenario,
} from './streaming-fixture-data';
import { gate, requestCounts } from './streaming-fixture-gates';

const FIXTURE_SCENARIOS = new Set<string>([
  'gated',
  'hold',
  'approval',
  'approval-long',
  'stepped',
  'tool',
  'ratelimited',
  'unauthorized',
  'fail-once401',
  'midstream',
]);

const MARKER_PATTERN =
  // `approval-long` BEFORE `approval`: alternation is first-match, so the
  // shorter name would match its prefix, leave `-long` unconsumed, and fail
  // the whole pattern — which reads as the fixture serving a default reply
  // rather than as a marker it could not parse.
  /\[fixture (gated|hold|approval-long|approval|stepped|tool|ratelimited|unauthorized|fail-once401|midstream) ([A-Za-z0-9-]+)\]/;

/**
 * Every write goes through here because a scenario can be parked on a gate when
 * the browser aborts: SvelteKit cancels its ndjson stream, the SDK aborts this
 * request, and the socket is gone before the resumed code writes again. Writing
 * to a dead socket throws inside an async continuation with nothing to catch
 * it, which would take the whole fixture process — and therefore every later
 * test in the run — down with it.
 */
function isFixtureScenario(value: string | undefined): value is FixtureScenario {
  return value !== undefined && FIXTURE_SCENARIOS.has(value);
}

function write(res: ServerResponse, chunk: string): boolean {
  if (res.writableEnded || res.destroyed) return false;
  res.write(chunk);
  return true;
}

function sse(res: ServerResponse, event: string, data: unknown): boolean {
  return write(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function beginMessage(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: 'msg_streaming_fixture',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
}

function endMessage(res: ServerResponse, stopReason: 'end_turn' | 'tool_use'): void {
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  if (!res.writableEnded && !res.destroyed) res.end();
}

function textBlock(res: ServerResponse, chunks: readonly string[]): void {
  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  for (const text of chunks) {
    sse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    });
  }
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
}

function respondToProviderFailure(
  res: ServerResponse,
  scenario: FixtureScenario,
  attempt: number,
): boolean {
  if (
    scenario !== 'ratelimited' &&
    scenario !== 'unauthorized' &&
    !(scenario === 'fail-once401' && attempt === 1)
  ) {
    return false;
  }
  const rateLimited = scenario === 'ratelimited';
  res.writeHead(rateLimited ? 429 : 401, {
    'Content-Type': 'application/json',
    // The provider transport underneath Operative retries a 429 on its
    // own with exponential backoff, which took one turn to roughly 25
    // seconds of wall clock. `retry-after: 0` keeps that retry POLICY
    // exactly as it is — same three attempts, same code path — while
    // telling it there is nothing to wait for, so the scenario costs
    // milliseconds. The alternative was a longer deadline on the
    // assertion, which would have hidden the cost rather than removed
    // it.
    //
    // Described by ROLE rather than by package name deliberately: the
    // lab talks to Operative, which chooses the provider client. Naming
    // the package here would make this comment wrong the day Operative
    // is pointed at a different one, and the behaviour being worked
    // around is the transport's, not that specific library's.
    ...(rateLimited ? { 'retry-after': '0' } : {}),
  });
  res.end(
    JSON.stringify({
      type: 'error',
      error: {
        type: rateLimited ? 'rate_limit_error' : 'authentication_error',
        message: rateLimited
          ? 'Rate limited by the fixture.'
          : 'Invalid API key supplied to the fixture.',
      },
    }),
  );
  return true;
}

function approvalToolText(scenario: FixtureScenario): string {
  return scenario === 'approval-long' ? APPROVAL_LONG_NOTE_TEXT : APPROVAL_NOTE_TEXT;
}

function respondToApprovalRequest(
  res: ServerResponse,
  scenario: FixtureScenario,
  marker: string,
): boolean {
  if (scenario !== 'approval' && scenario !== 'approval-long') return false;
  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'tool_use',
      id: `toolu_${marker}`,
      name: 'remember_note',
      input: {},
    },
  });
  sse(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'input_json_delta',
      partial_json: JSON.stringify({ text: approvalToolText(scenario) }),
    },
  });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  endMessage(res, 'tool_use');
  return true;
}

async function respondToToolRequest(
  res: ServerResponse,
  scenario: FixtureScenario,
  marker: string,
  attempt: number,
): Promise<boolean> {
  if (scenario !== 'tool' || attempt !== 1) return false;
  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: `toolu_${marker}`, name: TOOL_CALL_NAME, input: {} },
  });
  sse(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: TOOL_ARGUMENTS_FIRST_HALF },
  });

  if ((await gate(marker, res)) === 'disconnected') return true;

  sse(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: TOOL_ARGUMENTS_SECOND_HALF },
  });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  endMessage(res, 'tool_use');
  return true;
}

async function respondToSteppedText(
  res: ServerResponse,
  scenario: FixtureScenario,
  marker: string,
): Promise<boolean> {
  if (scenario !== 'stepped') return false;
  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  for (const [index, text] of STEPPED_CHUNKS.entries()) {
    sse(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: index === 0 ? text : ` ${text}` },
    });
    if (index === STEPPED_CHUNKS.length - 1) break;
    if ((await gate(marker, res)) === 'disconnected') return true;
  }
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  endMessage(res, 'end_turn');
  return true;
}

async function respondToGatedText(
  res: ServerResponse,
  scenario: FixtureScenario,
  marker: string,
): Promise<boolean> {
  if (scenario !== 'gated') return false;
  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  sse(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: `${GATED_FIRST_CHUNK} ` },
  });

  if ((await gate(marker, res)) === 'disconnected') return true;

  sse(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: GATED_SECOND_CHUNK },
  });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  endMessage(res, 'end_turn');
  return true;
}

function respondToMidstreamFailure(res: ServerResponse, scenario: FixtureScenario): boolean {
  if (scenario !== 'midstream') return false;
  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  sse(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: MIDSTREAM_PARTIAL_TEXT },
  });
  sse(res, 'error', {
    type: 'error',
    error: { type: 'overloaded_error', message: MIDSTREAM_ERROR_MESSAGE },
  });
  if (!res.writableEnded && !res.destroyed) res.end();
  return true;
}

async function respondToHeldText(
  res: ServerResponse,
  scenario: FixtureScenario,
  marker: string,
): Promise<boolean> {
  if (scenario !== 'hold') return false;
  sse(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  sse(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: HOLD_PARTIAL_TEXT },
  });
  // Never released, never completed: the client's abort is what ends it.
  // `gate` resolves on the socket close that abort produces, so nothing
  // is left waiting on a promise that can no longer settle.
  await gate(marker, res);
  return true;
}

function followUpText(scenario: FixtureScenario | undefined): string {
  if (scenario === 'approval' || scenario === 'approval-long') return APPROVAL_FOLLOW_UP_TEXT;
  if (scenario === 'tool') return TOOL_FOLLOW_UP_TEXT;
  return DEFAULT_REPLY_TEXT;
}

type OpenedScenarioResponder = (
  res: ServerResponse,
  scenario: FixtureScenario,
  marker: string,
  attempt: number,
) => boolean | Promise<boolean>;

const OPENED_SCENARIO_RESPONDERS: readonly OpenedScenarioResponder[] = [
  (res, scenario, marker, attempt) =>
    attempt === 1 ? respondToApprovalRequest(res, scenario, marker) : false,
  respondToToolRequest,
  respondToSteppedText,
  respondToGatedText,
  respondToMidstreamFailure,
  respondToHeldText,
];

async function respondToOpenedScenario(
  res: ServerResponse,
  scenario: FixtureScenario,
  marker: string,
  attempt: number,
): Promise<boolean> {
  for (const respond of OPENED_SCENARIO_RESPONDERS) {
    if (await respond(res, scenario, marker, attempt)) return true;
  }
  return false;
}

export async function respondToMessages(res: ServerResponse, body: string): Promise<void> {
  const match = MARKER_PATTERN.exec(body);
  const scenario = isFixtureScenario(match?.[1]) ? match[1] : undefined;
  const marker = match?.[2] ?? '';
  const attempt = (requestCounts.get(marker) ?? 0) + 1;
  if (marker) requestCounts.set(marker, attempt);

  if (scenario === undefined) {
    beginMessage(res);
    textBlock(res, [followUpText(scenario)]);
    endMessage(res, 'end_turn');
    return;
  }

  if (respondToProviderFailure(res, scenario, attempt)) return;

  beginMessage(res);
  if (await respondToOpenedScenario(res, scenario, marker, attempt)) return;

  textBlock(res, [followUpText(scenario)]);
  endMessage(res, 'end_turn');
}
