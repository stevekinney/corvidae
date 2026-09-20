import {
  createTool,
  createToolbox,
  type AnyToolbox,
  type ToolRequestContext,
} from '@corvidae/armorer';
import type { ChatStreamEvent } from '@corvidae/chat';
import {
  appendUserMessage,
  createConversationHistory,
  decodeChatStreamEvent,
} from '@corvidae/chat';
import {
  AbortAgentRunError,
  AgentRunError,
  createAgent,
  HookRegistry,
  OutputValidationError,
  stopWhen,
  withEnhancedStreaming,
  type AgentRun,
  type BeforeToolExecutionHook,
  type EnhancedStreamingOptions,
  type OperativeHookMap,
  type StreamingGenerateFunction,
} from '@corvidae/operative';
import { expect } from 'bun:test';
import { z } from 'zod';
import {
  classifyChatRunFailure,
  createChatAgent,
  createChatStreamWriter,
  startChatRun,
} from './chat-agent.ts';
import { pumpChatRun } from './chat-run-pump.ts';
import {
  parseServerOwnedPersistenceFailureHint,
  serverOwnedPersistenceFailureHint,
} from './server-owned-snapshot.ts';

export {
  AbortAgentRunError,
  AgentRunError,
  appendUserMessage,
  classifyChatRunFailure,
  createAgent,
  createChatAgent,
  createChatStreamWriter,
  createConversationHistory,
  createTool,
  createToolbox,
  decodeChatStreamEvent,
  HookRegistry,
  OutputValidationError,
  parseServerOwnedPersistenceFailureHint,
  pumpChatRun,
  serverOwnedPersistenceFailureHint,
  startChatRun,
  stopWhen,
  withEnhancedStreaming,
  z,
};
export type {
  AgentRun,
  AnyToolbox,
  BeforeToolExecutionHook,
  ChatStreamEvent,
  EnhancedStreamingOptions,
  OperativeHookMap,
  StreamingGenerateFunction,
  ToolRequestContext,
};

/**
 * Deterministic unit tests for the Operative-backed agent loop. Every
 * `generate` function here is hand-written and local — zero model or network
 * calls, per CIN-434. `test:unit` runs this file (see `package.json`).
 */

export const requestContext: ToolRequestContext = {
  authority: {
    principalId: 'test-user',
    tenantId: 'test-tenant',
    ownerId: 'test-session',
    capabilities: [],
    authorizationRevision: '1',
  },
  audience: 'tenant',
  agentId: 'test-assistant',
  runId: 'test-run',
};

class TestStreamingEventTarget extends EventTarget {
  dispatch(event: Event): boolean {
    return this.dispatchEvent(event);
  }
}

export function freshEventTarget(): NonNullable<EnhancedStreamingOptions['eventTarget']> {
  return new TestStreamingEventTarget();
}

export function conversationWith(userText: string) {
  return appendUserMessage(
    createConversationHistory({ id: `test-${crypto.randomUUID()}` }),
    userText,
  );
}

export const LEGACY_TYPES = new Set(['text', 'tool_call', 'tool_result']);
export const TERMINAL_TYPES = new Set([
  'run.completed',
  'run.error',
  'run.tripwire',
  'run.aborted',
]);

/** Parses the NDJSON lines the writer produced back into frames. */
export function decodeLines(lines: string[]): ChatStreamEvent[] {
  return lines.map((line) => {
    if (!line.endsWith('\n')) throw new Error(`frame is not newline-terminated: ${line}`);
    return decodeChatStreamEvent(JSON.parse(line));
  });
}

/** The three frames the client renders today, stripped of their envelope. */
export function legacyFrames(frames: ChatStreamEvent[]): Array<Record<string, unknown>> {
  return frames
    .filter((frame) => LEGACY_TYPES.has(frame.type))
    .map((frame) => {
      const stripped: Record<string, unknown> = { ...frame };
      delete stripped['wireVersion'];
      delete stripped['sequence'];
      return stripped;
    });
}

export function ofType<T extends ChatStreamEvent['type']>(
  frames: ChatStreamEvent[],
  type: T,
): Array<Extract<ChatStreamEvent, { type: T }>> {
  return frames.filter(
    (frame): frame is Extract<ChatStreamEvent, { type: T }> => frame.type === type,
  );
}

/**
 * Every frame carries the envelope, `sequence` is strictly increasing from
 * zero, and exactly one terminal `run.*` frame closes the stream — the
 * reference architecture's stream wire contract, asserted on every run.
 *
 * VERSION 2 since this lab began emitting `assistant.step.*` and
 * `elicitation.*`, which `@corvidae/chat` gates behind a version 2 envelope.
 * The version is asserted on EVERY frame rather than only on the new ones,
 * because a stream speaks one version for its whole length — a mixed stream
 * is rejected by `decodeChatStreamEvents`, so a producer that bumped only the
 * frames that needed it would emit a body no client could read.
 */
export function expectWellFormedWire(frames: ChatStreamEvent[]): void {
  frames.forEach((frame, index) => {
    expect(frame.wireVersion).toBe(2);
    expect(frame.sequence).toBe(index);
  });
  const terminals = frames.filter((frame) => TERMINAL_TYPES.has(frame.type));
  expect(terminals).toHaveLength(1);
  expect(frames.at(-1)).toBe(terminals[0]);
}

/**
 * Best-effort disposal, the same mechanism the route's `finally` uses
 * (`+server.ts`): `Symbol.dispose` is what releases the run's listeners,
 * which `abort` alone does not do.
 */
export function disposeRun(run: AgentRun): void {
  try {
    run[Symbol.dispose]();
  } catch {
    // Cleanup, not an outcome: a disposal failure must not replace the
    // assertion the test is actually making.
  }
}

export async function runAndCollect(
  generate: StreamingGenerateFunction,
  toolbox: AnyToolbox = createToolbox([]),
  lines: string[] = [],
  hooks?: HookRegistry<OperativeHookMap>,
  beforeFailure?: NonNullable<Parameters<typeof pumpChatRun>[2]>['beforeFailure'],
  conversation = conversationWith('hello'),
): Promise<{ frames: ChatStreamEvent[]; envelope: Awaited<ReturnType<typeof pumpChatRun>> }> {
  // Mirrors the route exactly: one request-local writer feeds both the
  // `stream:*` forwarding `createChatAgent` installs and the `tool.*`/`run.*`
  // frames `pumpChatRun` emits, so this collects the same bytes the wire sees.
  const writer = createChatStreamWriter((line) => lines.push(line));
  const agent = createChatAgent({
    generate,
    toolbox,
    requestContext,
    writer,
    ...(hooks === undefined ? {} : { hooks }),
  });
  const run = startChatRun(agent, conversation);
  // Disposed like the route disposes it, so a run's listeners cannot outlive
  // the test that made it and leak into the next one.
  const envelope = await pumpChatRun(
    run,
    writer,
    beforeFailure === undefined ? {} : { beforeFailure },
  ).finally(() => disposeRun(run));
  const frames = decodeLines(lines);
  expectWellFormedWire(frames);
  return { frames, envelope };
}
