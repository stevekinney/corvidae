import type { OwnedResource } from '../types.ts';
import { BUREAU_EVENT_CATALOG } from '../bureau-event-catalog.ts';
import {
  resolveWorkspaceOwner,
  type WorkspaceRuntimeAuthority,
} from '../http/workspace-principal.ts';
import type { HookEventToDeliver } from './hook-delivery.ts';

const sharedFields: Readonly<Record<string, readonly string[]>> = {
  'definitions.changed': ['catalog', 'added', 'changed', 'removed', 'rejected'],
  'schedule.created': ['agentName', 'scheduleId'],
  'schedule.paused': ['scheduleId'],
  'schedule.resumed': ['scheduleId'],
  'schedule.cancelled': ['scheduleId'],
};

/** Project before persistence: shared configuration is metadata, private events need an owner. */
export function workspaceHookEvents(
  workspace: WorkspaceRuntimeAuthority,
  ownerOf: (resource: OwnedResource) => Promise<string | undefined>,
): (owner: string, event: HookEventToDeliver) => Promise<HookEventToDeliver | undefined> {
  return async (owner, event) => {
    const member = await resolveWorkspaceOwner(workspace, owner);
    if (member === undefined || member.actorKind === 'service') return undefined;
    if (!Object.hasOwn(BUREAU_EVENT_CATALOG, event.kind)) return undefined;
    const fields = Object.hasOwn(sharedFields, event.kind) ? sharedFields[event.kind] : undefined;
    if (fields !== undefined) {
      const payload = Object.fromEntries(
        fields.flatMap((field) =>
          Object.hasOwn(event.payload, field)
            ? [[field, structuredClone(event.payload[field])]]
            : [],
        ),
      );
      return { ...event, payload };
    }
    // Read authoritative records, never an owner asserted in an event payload.
    for (const [field, kind] of [
      ['runId', 'run'],
      ['taskId', 'run'],
      ['sessionId', 'session'],
      ['goalRunId', 'goal'],
      ['scheduleId', 'schedule'],
      ['reviewId', 'review'],
    ] as const) {
      const id = Object.hasOwn(event.payload, field) ? event.payload[field] : undefined;
      if (typeof id !== 'string') continue;
      return (await ownerOf({ kind, id })) === owner ? event : undefined;
    }
    return undefined;
  };
}

/** Only these projected events can be sent to a destination another workspace admin controls. */
export function isSharedWebhook(
  action: { readonly type: string },
  events: readonly string[],
): boolean {
  return action.type === 'webhook' && events.every((kind) => Object.hasOwn(sharedFields, kind));
}
