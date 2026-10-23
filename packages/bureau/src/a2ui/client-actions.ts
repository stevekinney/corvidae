/**
 * The boundary where a renderer's A2UI client-to-server message enters Bureau (COR-837). Everything
 * in the message is untrusted: this reads exactly four fields of an `action` (`name`, `surfaceId`,
 * `sourceComponentId`, `context`), checks each, and ignores the rest. The caller, the task, the
 * revision, the idempotency key, and the authorization come from the authenticated request that
 * carried the message, never from its body, and the result is an ordinary `surface.action` that the
 * store reauthorizes: it can only continue its own surface's task, and a body that names a function
 * or a tool is not read at all, so a generated action cannot authorize itself or call one.
 *
 * @experimental A2UI support is pinned to v0.9.1 and may change until a stable A2UI 1.0 review.
 * @module client-actions
 */

import {
  INTERACTIVE_SURFACE_CONTRACT_VERSION,
  type InteractiveSurfaceActionDefinition,
  type InteractiveSurfaceActionRequest,
  type InteractiveSurfaceJsonObject,
} from '../interactive-surface/types.ts';
import { jsonProblemOf } from './messages.ts';

/** The longest an action name, surface id, or component id may be, in characters. */
const MAX_NAME_LENGTH = 128;
/** The most JSON a context may hold, in characters. */
const MAX_CONTEXT_CHARACTERS = 262_144;

/** The four fields of a client action Bureau reads. @experimental */
export interface A2uiClientAction {
  readonly name: string;
  readonly surfaceId: string;
  readonly sourceComponentId?: string | undefined;
  /** The values the component's event bound, resolved by the renderer. Data only. */
  readonly context: InteractiveSurfaceJsonObject;
}

/** The outcome of reading a client message. @experimental */
export type A2uiClientMessage =
  | { readonly ok: true; readonly kind: 'action'; readonly action: A2uiClientAction }
  | {
      readonly ok: true;
      readonly kind: 'error';
      /** What the renderer reported, for the adapter to record. Never a command. */
      readonly error: {
        readonly code: string;
        readonly surfaceId?: string;
        readonly message: string;
      };
    }
  | { readonly ok: false; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME_LENGTH;
}

/**
 * Reads one client-to-server message: an object holding `action` or `error`, or an array of
 * exactly one such object (the shape the A2A extension's data part carries).
 *
 * @experimental
 */
export function parseClientMessage(envelope: unknown): A2uiClientMessage {
  let message: unknown = envelope;
  if (Array.isArray(envelope)) {
    if (envelope.length !== 1) {
      return { ok: false, message: 'A client message holds exactly one A2UI message.' };
    }
    message = envelope[0];
  }
  if (!isRecord(message))
    return { ok: false, message: 'An A2UI client message must be a JSON object.' };
  const version = message['version'];
  if (version !== undefined && version !== 'v0.9' && version !== 'v0.9.1') {
    return { ok: false, message: 'The A2UI client message version is not one Bureau supports.' };
  }
  const hasAction = Object.hasOwn(message, 'action');
  const hasError = Object.hasOwn(message, 'error');
  if (hasAction === hasError) {
    return { ok: false, message: 'A client message carries exactly one of action or error.' };
  }
  if (hasError) {
    const error = message['error'];
    if (!isRecord(error)) return { ok: false, message: 'The A2UI error must be an object.' };
    const code =
      typeof error['code'] === 'string' ? error['code'].slice(0, MAX_NAME_LENGTH) : 'UNKNOWN';
    const text = typeof error['message'] === 'string' ? error['message'].slice(0, 1000) : '';
    const surfaceId = boundedString(error['surfaceId']) ? error['surfaceId'] : undefined;
    return {
      ok: true,
      kind: 'error',
      error: { code, message: text, ...(surfaceId === undefined ? {} : { surfaceId }) },
    };
  }
  const action = message['action'];
  if (!isRecord(action)) return { ok: false, message: 'The A2UI action must be an object.' };
  const { name, surfaceId, sourceComponentId, context } = action;
  if (!boundedString(name)) return { ok: false, message: 'The A2UI action needs a name.' };
  if (!boundedString(surfaceId))
    return { ok: false, message: 'The A2UI action needs a surfaceId.' };
  if (sourceComponentId !== undefined && !boundedString(sourceComponentId)) {
    return { ok: false, message: 'The A2UI action’s sourceComponentId must be a short string.' };
  }
  if (context !== undefined && !isRecord(context)) {
    return { ok: false, message: 'The A2UI action’s context must be an object.' };
  }
  const body = context ?? {};
  const problem = jsonProblemOf(body);
  if (problem !== undefined) return { ok: false, message: `The A2UI action’s context ${problem}.` };
  if (JSON.stringify(body).length > MAX_CONTEXT_CHARACTERS) {
    return { ok: false, message: 'The A2UI action’s context is too large.' };
  }
  return {
    ok: true,
    kind: 'action',
    action: {
      name,
      surfaceId,
      context: body as InteractiveSurfaceJsonObject,
      ...(sourceComponentId === undefined ? {} : { sourceComponentId }),
    },
  };
}

/** What the authenticated request supplies for an action; none of it comes from the message body. @experimental */
export interface A2uiActionContext {
  /** The task the request addresses. */
  readonly taskId: string;
  /** The request's idempotency key. */
  readonly commandId: string;
  /** The surface revision the client last received, as the transport tracks it. */
  readonly revision: number;
  /** When the request arrived (ISO 8601). */
  readonly timestamp?: string | undefined;
}

/**
 * The `surface.action` command for a parsed client action. The store admits it only for an action
 * the surface declares, from a caller it authorizes, at the revision the surface is at, and
 * validates `context` against the action's `valueSchema`. Pass the surface's declared action (for
 * an `a2ui` surface) so an empty context on an action without a schema is sent as no value.
 *
 * @experimental
 */
export function toActionRequest(
  action: A2uiClientAction,
  context: A2uiActionContext,
  declared?: Pick<InteractiveSurfaceActionDefinition, 'valueSchema'>,
): InteractiveSurfaceActionRequest {
  // An A2UI event with no bindings carries an empty (or absent) context, and the Chat renderer
  // sends `{}`. For an action that declares no `valueSchema` that is the no-value action, which the
  // store takes as `null`; for one that declares a schema, `{}` is a value like any other.
  const noValue =
    declared !== undefined &&
    declared.valueSchema === undefined &&
    Object.keys(action.context).length === 0;
  return {
    type: 'surface.action',
    contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
    commandId: context.commandId,
    taskId: context.taskId,
    surfaceId: action.surfaceId,
    revision: context.revision,
    action: action.name,
    value: noValue ? null : action.context,
    ...(action.sourceComponentId === undefined
      ? {}
      : { sourceComponentId: action.sourceComponentId }),
    ...(context.timestamp === undefined ? {} : { timestamp: context.timestamp }),
  };
}
