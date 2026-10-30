/**
 * Every storage key prefix Bureau writes, so a storage explorer or an
 * embedding application can tell Bureau-owned keys from its own. Each value is
 * the literal a source constant declares, so a prefix that omits its trailing
 * separator here omits it there. `reserved-key-prefixes.test.ts` scans the
 * source and fails when a key-prefix constant is missing from this list or a
 * listed prefix is no longer written, so a new prefix cannot ship unlisted.
 */
export const BUREAU_RESERVED_KEY_PREFIXES: readonly string[] = [
  'asset:v1:',
  'audit:v1:',
  'audit-dedupe:v1:',
  'audit-retention:v1:',
  'audit-sequence:v1:',
  'bureau-a2a-context:v1:',
  'bureau-a2a-push:v1:',
  'bureau-a2a-task:v1:',
  'bureau-agent-revision:v1:',
  'bureau-agent-run:v1:',
  'bureau-agent-snapshot:v1:',
  'bureau-catalog-run:',
  'bureau-child:parent:',
  'bureau-child:record:',
  'bureau-delegation:grant:',
  'bureau-delegation:ledger:',
  'bureau-goal:record:',
  'bureau-peer-call:record:',
  'bureau-removed-surfaces:v1:',
  'bureau-schedule-transition:',
  'bureau-surface:v1:',
  'bureau-task-context:v1:',
  'bureau-task-listing:v2:',
  'bureau-task:v1:',
  'bureau-workflow-cancelled-run:v1:',
  'bureau-workflow-schedule:',
  'bureau-workflow-snapshot:v1:',
  'ag-ui-lease:v1',
  'command-ledger:a2a-send:v1',
  'command-ledger:fork:v1',
  'command-ledger:tasks-respond:v1',
  'command-ledger:v1',
  'outbox-dedupe:',
  'proposal:',
  'review-decision:v1',
  'session-deletion-owner:v1:',
  'session-input-identity:v1',
  'session-input-open:v2:',
  'skill:',
  'steering-key:v1',
  'steering-log:v1',
  'webhook-delivery:v1:',
];
