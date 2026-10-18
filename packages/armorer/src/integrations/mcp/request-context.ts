import {
  BAGGAGE_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
  type ClientCapabilities,
  type Implementation,
  type ProgressToken,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { propagation, ROOT_CONTEXT, type Context } from '@opentelemetry/api';

import type { Tool } from '../../is-tool';

/** The two MCP protocol eras the SDK serves: 2025-11-25 and earlier, and 2026-07-28. */
export type MCPProtocolEra = 'legacy' | 'modern';

/** W3C trace context a request carried in its `_meta`. */
export type MCPRequestTraceCarrier = {
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly baggage?: string;
};

/**
 * The protocol facts of the MCP request driving a tool execution, delivered
 * to the tool as `context.executionContext.mcp`. Each field is present only
 * when the protocol supplies it: a 2026-07-28 request carries its version,
 * client information, and capabilities in its own envelope; a 2025-era
 * request has them only from its `initialize` handshake, which the stateless
 * legacy HTTP lane never runs. MCP defines no request deadline, so none is
 * reported.
 */
export type MCPRequestExecutionContext = {
  readonly era: MCPProtocolEra;
  readonly method: string;
  readonly requestId: string;
  readonly protocolVersion?: string;
  readonly clientInfo?: Implementation;
  readonly clientCapabilities?: ClientCapabilities;
  readonly trace?: MCPRequestTraceCarrier;
};

/**
 * Session-scoped facts a 2025-era connection learned at `initialize`.
 * `createMCP` reads them from the SDK server instance; a caller of
 * `toMcpTools` that owns its own server supplies them the same way.
 */
export type MCPClientSession = {
  clientCapabilities?: () => ClientCapabilities | undefined;
  clientInfo?: () => Implementation | undefined;
  protocolVersion?: () => string | undefined;
};

type RequestFacts = {
  readonly context: MCPRequestExecutionContext;
  readonly traceContext?: Context;
  readonly progressToken?: ProgressToken;
};

/** Collects the protocol facts of one MCP request. */
export function readRequestFacts(
  context: ServerContext | undefined,
  session: MCPClientSession | undefined,
): RequestFacts {
  const envelope = context?.mcpReq.envelope as Record<string, unknown> | undefined;
  const envelopeVersion = envelope?.[PROTOCOL_VERSION_META_KEY];
  const era: MCPProtocolEra = typeof envelopeVersion === 'string' ? 'modern' : 'legacy';
  const protocolVersion =
    typeof envelopeVersion === 'string' ? envelopeVersion : session?.protocolVersion?.();
  const clientInfo =
    (envelope?.[CLIENT_INFO_META_KEY] as Implementation | undefined) ?? session?.clientInfo?.();
  const clientCapabilities =
    (envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined) ??
    session?.clientCapabilities?.();
  const meta: Record<string, unknown> | undefined = context?.mcpReq._meta;
  const trace = readTraceCarrier(meta);

  const mcp: MCPRequestExecutionContext = Object.freeze({
    era,
    method: context?.mcpReq.method ?? 'tools/call',
    requestId: context?.mcpReq.id !== undefined ? String(context.mcpReq.id) : '',
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    ...(clientInfo !== undefined ? { clientInfo } : {}),
    ...(clientCapabilities !== undefined ? { clientCapabilities } : {}),
    ...(trace !== undefined ? { trace } : {}),
  });
  const progressToken = meta?.['progressToken'] as ProgressToken | undefined;
  return {
    context: mcp,
    ...(trace !== undefined ? { traceContext: propagation.extract(ROOT_CONTEXT, trace) } : {}),
    ...(progressToken !== undefined ? { progressToken } : {}),
  };
}

function readTraceCarrier(
  meta: Record<string, unknown> | undefined,
): MCPRequestTraceCarrier | undefined {
  if (!meta) return undefined;
  const carrier: { traceparent?: string; tracestate?: string; baggage?: string } = {};
  const traceparent = meta[TRACEPARENT_META_KEY];
  const tracestate = meta[TRACESTATE_META_KEY];
  const baggage = meta[BAGGAGE_META_KEY];
  if (typeof traceparent === 'string') carrier.traceparent = traceparent;
  if (typeof tracestate === 'string') carrier.tracestate = tracestate;
  if (typeof baggage === 'string') carrier.baggage = baggage;
  return Object.keys(carrier).length ? Object.freeze(carrier) : undefined;
}

/** Where one request round's progress notifications go. */
export type McpProgressSink = {
  readonly token: ProgressToken;
  readonly notify: ServerContext['mcpReq']['notify'];
};

/**
 * Forwards an execution's Armorer progress events as MCP
 * `notifications/progress` to whichever request round is currently in
 * flight. MCP requires `progress` to increase on every notification for a
 * token, so a percent update is sent as `{ progress: percent, total: 100 }`
 * only when it advances, and a message-only update advances a counter until
 * the tool first reports a percent (after which a message-only update cannot
 * be placed on the scale and is dropped).
 */
export function createProgressForwarder() {
  let sink: McpProgressSink | undefined;
  let last = 0;
  let percentSeen = false;
  // The token `last` and `percentSeen` belong to; it outlives the sink, which
  // is cleared between rounds.
  let sequenceToken: ProgressToken | undefined;
  return {
    setSink(next: McpProgressSink | undefined) {
      // Ordering is scoped to a progress token, so a round that brings a new
      // token starts its own increasing sequence.
      if (next !== undefined && next.token !== sequenceToken) {
        sequenceToken = next.token;
        last = 0;
        percentSeen = false;
      }
      sink = next;
    },
    forward(update: { percent?: number | undefined; message?: string | undefined }) {
      if (!sink) return;
      const params = nextProgressParams(update);
      if (!params) return;
      sink
        .notify({
          method: 'notifications/progress',
          params: { progressToken: sink.token, ...params },
        })
        .catch(() => undefined);
    },
  };

  function nextProgressParams(update: {
    percent?: number | undefined;
    message?: string | undefined;
  }): { progress: number; total?: number; message?: string } | undefined {
    const message = update.message !== undefined ? { message: update.message } : {};
    if (typeof update.percent === 'number' && Number.isFinite(update.percent)) {
      if (update.percent <= last) return undefined;
      last = update.percent;
      percentSeen = true;
      return { progress: last, total: 100, ...message };
    }
    if (percentSeen) return undefined;
    last += 1;
    return { progress: last, ...message };
  }
}

/**
 * Subscribes to a tool's progress events for one execution. A toolbox runs
 * the call as a child of the supplied execution id (`<id>:call:<n>`), so the
 * child's events match as well.
 */
export function subscribeToExecutionProgress(
  tool: Tool,
  executionId: string,
  forward: (update: { percent?: number | undefined; message?: string | undefined }) => void,
): () => void {
  // Tool-like objects accepted by `toMcpTools` need not carry events.
  if (typeof tool.addEventListener !== 'function') return () => undefined;
  const childPrefix = `${executionId}:`;
  return tool.addEventListener('progress', (event) => {
    const eventId = event.executionId;
    if (eventId !== executionId && !eventId?.startsWith(childPrefix)) return;
    forward({ percent: event.percent, message: event.message });
  });
}
