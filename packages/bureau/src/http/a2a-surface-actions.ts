/**
 * An A2UI client action sent to a task over A2A (COR-837).
 *
 * A renderer answers a surface with an A2UI `action` message in a data part. When the request
 * activated A2UI's extension and the message names an `a2ui` surface of the task, the action is
 * read at the boundary (`parseClientMessage` takes four fields), reauthorized by the surface store
 * as the task's owner, and only then turned into the answer it stands for: the continuation the
 * HOST declared on the action, never anything the message names. The answer travels the same
 * ledgered path as any other answer to a wait.
 *
 * @module a2a-surface-actions
 */

import type { Message } from '@a2a-js/sdk';

import { A2UI_EXTENSION_URI } from '../a2ui/catalogs.ts';
import { parseClientMessage, toActionRequest } from '../a2ui/client-actions.ts';
import { INTERACTIVE_SURFACE_CONTRACT_VERSION } from '../interactive-surface/types.ts';
import type { TaskView } from '../task-registry.ts';
import type { Bureau, BureauReviews } from '../types.ts';
import type { TasksRespondInput } from '../tasks/respond-to-task.ts';

/**
 * The message-metadata key that carries the surface revision a renderer last received. A2UI's
 * `action` has no revision of its own, so the surface part of a read carries its `revision` and
 * the client echoes it here. Without this key an action is accepted only while the surface is
 * still at revision 1; once it has been updated, a missing revision is refused as stale, so a
 * click never applies to a UI its sender did not see.
 */
export const SURFACE_REVISION_METADATA_KEY = 'a2uiSurfaceRevision';

/** What reading a surface action found. */
export type SurfaceAction =
  | { readonly ok: true; readonly input: TasksRespondInput }
  | {
      readonly ok: false;
      readonly message: string;
      /** Set when the action answered a revision the surface has moved past. */
      readonly stale?: { readonly surfaceId: string; readonly currentRevision: number };
    };

function firstDataPart(message: Message): unknown {
  for (const part of message.parts) {
    if (part.content?.$case === 'data') return part.content.value;
  }
  return undefined;
}

/**
 * The answer an A2UI action stands for, `{ ok: false }` with the reason when the surface store
 * refuses it, or `undefined` when the message is not an action on one of this task's `a2ui`
 * surfaces (so the ordinary answer paths read it).
 */
export async function surfaceActionOf(options: {
  readonly bureau: Pick<Bureau, 'surfaces'> & { readonly reviews: Pick<BureauReviews, 'get'> };
  readonly message: Message;
  readonly view: TaskView;
  readonly activated: ReadonlySet<string>;
}): Promise<SurfaceAction | undefined> {
  const { bureau, message, view, activated } = options;
  const surfaces = bureau.surfaces;
  if (surfaces === undefined || !activated.has(A2UI_EXTENSION_URI)) return undefined;
  if (view.status !== 'input-required') return undefined;
  const parsed = parseClientMessage(firstDataPart(message));
  if (!parsed.ok || parsed.kind !== 'action') return undefined;
  const { action } = parsed;
  // Authorized as the task's owner, which the handler has already established the caller is.
  const authorization = { principal: view.owner };
  const found = await surfaces.snapshot(
    {
      type: 'surface.snapshot',
      contractVersion: INTERACTIVE_SURFACE_CONTRACT_VERSION,
      taskId: view.id,
      surfaceId: action.surfaceId,
    },
    authorization,
  );
  if (found.outcome !== 'found' || found.surface.kind !== 'a2ui') return undefined;
  const stated = message.metadata?.[SURFACE_REVISION_METADATA_KEY];
  if (typeof stated !== 'number' && found.surface.revision > 1) {
    return {
      ok: false,
      message: `The surface refused the action: stale-revision (the surface is at revision ${found.surface.revision}; state metadata.${SURFACE_REVISION_METADATA_KEY}).`,
      stale: { surfaceId: action.surfaceId, currentRevision: found.surface.revision },
    };
  }
  const revision = typeof stated === 'number' ? stated : found.surface.revision;
  const declared = found.surface.actions.find((entry) => entry.name === action.name);
  const admission = await surfaces.act(
    toActionRequest(
      action,
      { taskId: view.id, commandId: `a2ui-action:${message.messageId}`, revision },
      declared,
    ),
    authorization,
  );
  if (admission.outcome === 'rejected') {
    return {
      ok: false,
      message: `The surface refused the action: ${admission.reason}${admission.detail === undefined ? '' : ` (${admission.detail})`}.`,
      ...(admission.reason === 'stale-revision'
        ? {
            stale: {
              surfaceId: action.surfaceId,
              currentRevision: admission.currentRevision ?? found.surface.revision,
            },
          }
        : {}),
    };
  }
  const { continuation, value, intent } = admission;
  const payload =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  // A valueless action answers with its own name; a value is the signal's payload.
  const answerOf =
    payload !== undefined && Object.keys(payload).length > 0
      ? { data: payload }
      : { answer: action.name };
  const base = { taskId: view.id, messageId: message.messageId } as const;
  if (continuation.type === 'signal') {
    const named = view.openWaits.some(
      (wait) => wait.kind === 'human-wait' && wait.signalName === continuation.signalName,
    );
    if (!named) {
      return { ok: false, message: `The task is not waiting on "${continuation.signalName}".` };
    }
    return {
      ok: true,
      input: { ...base, signalName: continuation.signalName, ...answerOf },
    };
  }
  const wait = view.openWaits.find((entry) => entry.reviewId === continuation.reviewId);
  if (wait === undefined) {
    return { ok: false, message: 'The review this action continues is no longer open.' };
  }
  if (wait.kind === 'tool-approval') {
    if (intent !== 'approve' && intent !== 'deny') {
      return { ok: false, message: 'An approval is decided by an approve or deny action.' };
    }
    // A re-gated approval keeps its id and advances its round: a surface declared for an earlier
    // round must not decide the new one.
    if (continuation.round !== undefined) {
      const review = await bureau.reviews.get(wait.reviewId);
      if (review?.kind === 'tool-approval' && review.round !== continuation.round) {
        return {
          ok: false,
          message: `The surface refused the action: stale-round (the approval is at round ${review.round}, the surface shows round ${continuation.round}).`,
        };
      }
    }
    return { ok: true, input: { ...base, callId: wait.callId, decision: intent } };
  }
  return {
    ok: true,
    input: { ...base, signalName: wait.signalName, ...answerOf },
  };
}
