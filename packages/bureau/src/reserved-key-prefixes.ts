/**
 * Every storage key prefix Bureau writes, so a storage explorer or an
 * embedding application can tell Bureau-owned keys from its own. An entry
 * matches a key by `startsWith`, so a few entries are whole keys rather than
 * prefixes: `settings`, `outbox-dedupe-reconciliation-pending`, and
 * `bureau-a2a-push-fingerprint-key:v1`. Each value is the literal a source
 * constant or call declares, so a prefix that omits its trailing separator here
 * omits it there. The keys the durable engine and the session store write into
 * the same storage (`wf:`, `ev:`, `agent-session:`, and the like) belong to
 * Weft and Operative and are not listed.
 *
 * `reserved-key-prefixes.test.ts` guards the list from both sides. A scan of the
 * source fails when a key constant or a `keyPrefix` argument is missing from
 * this list or a listed entry is no longer written, and a run of a real Bureau
 * fails when it writes a key that no entry covers.
 */
export const BUREAU_RESERVED_KEY_PREFIXES: readonly string[] = [
  'asset:v1:',
  'audit:v1:',
  'audit-dedupe:v1:',
  'audit-retention:v1:',
  'audit-sequence:v1:',
  'bureau-a2a-context:v1:',
  'bureau-a2a-push:v1:',
  'bureau-a2a-push-fingerprint-key:v1',
  'bureau-a2a-task:v1:',
  'bureau-agent-revision:v1:',
  'bureau-agent-run:v1:',
  'bureau-agent-snapshot:v1:',
  'bureau-agent-version:v1:',
  'bureau-catalog-run:',
  'bureau-child:parent:',
  'bureau-child:record:',
  'bureau-delegation:grant:',
  'bureau-delegation:ledger:',
  'bureau-goal:record:',
  'bureau-peer-call:record:',
  'bureau-removed-surfaces:v1:',
  'bureau-schedule-transition:',
  'bureau-secret-answer:v1:',
  'bureau-surface:v1:',
  'bureau-task-context:v1:',
  'bureau-task-listing:v3:',
  'bureau-task:v1:',
  'bureau-workflow-cancelled-run:v1:',
  'bureau-workflow-schedule:',
  'bureau-workflow-snapshot:v1:',
  'ag-ui-lease:v1',
  'command-ledger:a2a-send:v1',
  'command-ledger:ag-ui-resume:v1',
  'command-ledger:fork:v1',
  'command-ledger:tasks-respond:v1',
  'command-ledger:v1',
  'outbox-dedupe:',
  'outbox-dedupe-reconciliation-pending',
  'proposal:',
  'review-decision:v1',
  'session-deletion-owner:v1:',
  'session-input-identity:v1',
  'session-input-open:v2:',
  'settings',
  'skill:',
  'steering-key:v1',
  'steering-log:v1',
  'webhook-delivery:v1:',
  'worker-deployment:',
];
