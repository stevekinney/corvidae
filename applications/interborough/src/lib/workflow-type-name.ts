/**
 * What a person calls a workflow type where a run's page names it: the recorded display name for a
 * type Interborough runs itself (`agentRun` is "Chat with an agent"), else the identifier in words
 * ("release-notes" reads "Release notes"). The recorded names are in `copy.ts`.
 */
import { humanizeIdentifier } from '@lostgradient/cinder';

import { RUN_DETAIL_COPY, WORKFLOW_COPY } from '../app/copy.ts';

/** The display name Interborough records for a workflow type it runs itself, or `undefined`. */
export function builtInWorkflowName(type: string): string | undefined {
  return Object.hasOwn(RUN_DETAIL_COPY.workflowNames, type)
    ? RUN_DETAIL_COPY.workflowNames[type as keyof typeof RUN_DETAIL_COPY.workflowNames]
    : undefined;
}

/**
 * Whether Interborough registers the workflow type itself (a chat, a goal's attempt, the heartbeat,
 * the schedule record), which starts itself: no page sets up a run of it by hand.
 */
export function isBuiltInWorkflow(type: string): boolean {
  return (
    builtInWorkflowName(type) !== undefined || Object.hasOwn(WORKFLOW_COPY.internal.types, type)
  );
}

/** The name of a workflow type for a person: the recorded name, else the identifier in words. */
export function workflowTypeName(type: string): string {
  return builtInWorkflowName(type) ?? humanizeIdentifier(type, { casing: 'sentence' });
}
