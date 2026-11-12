/**
 * What a person calls a workflow type where a run's page names it: the recorded display name for a
 * type Interborough runs itself (`agentRun` is "Chat with an agent"), else the identifier in words
 * ("release-notes" reads "Release notes"). The recorded names are in `app/copy/workflows.ts`.
 */
import { humanizeIdentifier } from '@lostgradient/cinder';

import { RUN_DETAIL_COPY } from '../app/copy/runs.ts';
import { WORKFLOW_COPY } from '../app/copy/workflows.ts';

/** The display name Interborough records for a workflow type it runs itself, or `undefined`. */
export function builtInWorkflowName(type: string): string | undefined {
  const names: Readonly<Record<string, string>> = RUN_DETAIL_COPY.workflowNames;
  return Object.hasOwn(names, type) ? names[type] : undefined;
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
