import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import type { BaseContext } from '@modelcontextprotocol/client';
import {
  inputRequired,
  type ElicitRequest,
  type ElicitRequestFormParams,
  type ElicitRequestURLParams,
  type ElicitResult,
  type InputRequest,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

import type {
  ToolElicitationRequest,
  ToolElicitationRequester,
  ToolElicitationResult,
} from '../../is-tool';

// `toElicitRequestParams` is a standalone request-shaping utility, not
// composed from any toolbox's own `RuntimeServices`, so its identifier
// generation draws from one process-local default instance (AB-92 AC4,
// AB-254).
const defaultElicitationRuntime = createDefaultRuntimeServices();

const EMPTY_FORM_SCHEMA = { type: 'object', properties: {} } as const;

/**
 * Translates a transport-agnostic {@link ToolElicitationRequest} into MCP
 * wire params for a 2025-era `elicitation/create` request (form or URL mode).
 */
function toElicitRequestParams(
  request: ToolElicitationRequest,
): ElicitRequestFormParams | ElicitRequestURLParams {
  if (request.mode === 'url') {
    if (!request.url) {
      throw new TypeError('URL-mode elicitation requires a `url`.');
    }
    return {
      mode: 'url',
      message: request.message,
      url: request.url,
      elicitationId: defaultElicitationRuntime.identifiers.next('elicitation'),
    };
  }
  return {
    mode: 'form',
    message: request.message,
    requestedSchema: (request.schema ??
      EMPTY_FORM_SCHEMA) as ElicitRequestFormParams['requestedSchema'],
  };
}

/**
 * Translates a {@link ToolElicitationRequest} into the embedded request of a
 * 2026-07-28 `input_required` result. URL mode carries no `elicitationId` on
 * this revision; the SDK synthesizes one when the legacy shim relays it.
 */
export function toElicitationInputRequest(request: ToolElicitationRequest): InputRequest {
  if (request.mode === 'url') {
    if (!request.url) {
      throw new TypeError('URL-mode elicitation requires a `url`.');
    }
    return inputRequired.elicitUrl({ message: request.message, url: request.url });
  }
  return inputRequired.elicit({
    message: request.message,
    requestedSchema: (request.schema ??
      EMPTY_FORM_SCHEMA) as ElicitRequestFormParams['requestedSchema'],
  });
}

/**
 * Translates an MCP `ElicitResult` back into our transport-agnostic shape.
 *
 * For an accepted form-mode result, validates `content` against the
 * requested schema first — a tool calling `context.elicit()` trusts the
 * response to honor the schema it asked for, so a client returning malformed
 * content (wrong types, missing required fields) fails loudly here instead
 * of silently reaching the tool and driving an incorrect action. The same
 * check runs for both protocol eras.
 */
export function fromElicitResult(
  result: Pick<ElicitResult, 'action' | 'content'>,
  request: ToolElicitationRequest,
): ToolElicitationResult {
  if (result.action === 'accept') {
    const content = result.content ?? {};
    if (request.mode !== 'url') {
      const parsed = toRequestedSchema(request.message, request.schema).safeParse(content);
      if (!parsed.success) {
        throw new TypeError(
          `Elicitation response for "${request.message}" did not match the requested schema: ${parsed.error.message}`,
        );
      }
    }
    return { action: 'accept', content };
  }
  if (result.action === 'decline') {
    return { action: 'decline' };
  }
  return { action: 'cancel' };
}

/**
 * Converts a form request's JSON Schema strictly (draft 2020-12), so every
 * constraint it states — `pattern`, `minimum`, `format`, enums — is enforced
 * on the answer. A schema that cannot be converted fails closed.
 */
function toRequestedSchema(
  message: string,
  schema: Record<string, unknown> | undefined,
): z.ZodType {
  try {
    return z.fromJSONSchema(schema ?? EMPTY_FORM_SCHEMA, { defaultTarget: 'draft-2020-12' });
  } catch (error) {
    throw new TypeError(
      `Elicitation schema for "${message}" cannot be enforced: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Translates an MCP `ElicitRequest`'s params into our transport-agnostic shape. */
export function toToolElicitationRequest(params: ElicitRequest['params']): ToolElicitationRequest {
  if (params.mode === 'url') {
    return { message: params.message, mode: 'url', url: params.url };
  }
  return {
    message: params.message,
    mode: 'form',
    schema: params.requestedSchema as unknown as Record<string, unknown>,
  };
}

/**
 * Translates our transport-agnostic result back into an MCP `ElicitResult`.
 * The wire schema requires `content` on every action (not just `accept`) —
 * the SDK's transform only fills in `{}` for genuinely `undefined` input, not
 * a missing key, so we always send the field explicitly.
 */
export function toElicitResult(result: ToolElicitationResult): ElicitResult {
  return {
    action: result.action,
    content: (result.action === 'accept' ? (result.content ?? {}) : {}) as ElicitResult['content'],
  };
}

/**
 * Builds an MCP client request handler for `elicitation/create`, adapting a
 * transport-agnostic {@link ToolElicitationRequester} to the SDK's wire
 * shape. Register it on an MCP `Client` to answer elicitation from a
 * connected server:
 *
 * ```ts
 * import { Client } from '@modelcontextprotocol/client';
 * import { createMcpElicitationHandler } from 'armorer';
 *
 * client.setRequestHandler(
 *   'elicitation/create',
 *   createMcpElicitationHandler(async (request) => {
 *     // request.mode === 'form' | 'url'
 *     return { action: 'accept', content: { approved: true } };
 *   }),
 * );
 * ```
 *
 * The same registration serves both protocol eras: on a 2025-era connection
 * the server sends `elicitation/create` directly, and on a 2026-07-28
 * connection the SDK client routes each embedded elicitation of an
 * `input_required` result through this handler before retrying the call.
 */
export function createMcpElicitationHandler(
  respond: ToolElicitationRequester,
): (request: ElicitRequest, extra: BaseContext) => Promise<ElicitResult> {
  return async (request) => {
    const toolRequest = toToolElicitationRequest(request.params);
    const result = await respond(toolRequest);
    return toElicitResult(result);
  };
}

/**
 * Builds a {@link ToolElicitationRequester} backed by a 2025-era request's
 * `context.mcpReq.elicitInput`, letting a tool's `execute` ask the connected
 * client for approval or human input mid-execution. `createMCP` uses this on
 * 2025-11-25 connections; on 2026-07-28 requests the SDK forbids push-style
 * elicitation and `createMCP` suspends the execution behind an
 * `input_required` result instead.
 */
export function createMcpToolElicitationRequester(extra: ServerContext): ToolElicitationRequester {
  return async (request) => {
    const params = toElicitRequestParams(request);
    const result = await extra.mcpReq.elicitInput(
      params,
      // Propagate the tool call's abort signal so a cancelled `tools/call`
      // also cancels the nested `elicitation/create` request instead of
      // leaving it pending until the client answers or it times out.
      extra.mcpReq.signal ? { signal: extra.mcpReq.signal } : undefined,
    );
    return fromElicitResult(result, request);
  };
}
