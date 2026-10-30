/**
 * Every storage key family Bureau writes, so a storage explorer or an embedding application can
 * tell Bureau-owned keys from its own, and what a chat's delete does to each (COR-1934).
 *
 * An entry matches a key by `startsWith`, so a few entries are whole keys rather than prefixes:
 * `settings`, `outbox-dedupe-reconciliation-pending`, and `bureau-a2a-push-fingerprint-key:v1`.
 * Each value is the literal a source constant or call declares, so a prefix that omits its
 * trailing separator here omits it there. The keys the durable engine and the session store write
 * into the same storage (`wf:`, `ev:`, `agent-session:`, and the like) belong to Weft and
 * Operative and are not listed here; the ones a chat's runs write are classified in
 * {@link SHARED_KEY_FAMILIES_OF_A_CHAT}.
 *
 * ## What a chat's delete does to a family
 *
 * A chat delete purges everything a user or an agent authored in it (owner decision, COR-1934),
 * and the purge is complete only if every family is accounted for. So every family carries its
 * classification, and the type refuses a family without one:
 *
 * - `purged`: the family holds a chat's content, and `contexts.delete` removes the keys of the
 *   chat and of its runs (`chat-content-purge.ts`);
 * - `content-free`: the family may name the chat or its runs, but holds nothing anyone wrote,
 *   so its keys may stay; the reason says what it holds;
 * - `kept`: the family is kept on purpose, with the reason: it is not the chat's (an agent's
 *   definition, a goal's record), or it is kept with its content removed (the audit trail).
 *
 * `reserved-key-prefixes.test.ts` guards the list from both sides. A scan of the source fails
 * when a key constant or a `keyPrefix` argument is missing from this list or a listed entry is no
 * longer written, and a run of a real Bureau fails when it writes a key that no entry covers.
 * `chat-delete-purge-content.test.ts` then holds every family to its classification: after a
 * chat is deleted, a key of a `purged` family may not name the chat or one of its runs, no key of
 * any family may hold what was said in the chat, and a key no family here or in
 * {@link SHARED_KEY_FAMILIES_OF_A_CHAT} covers fails the test.
 */

/** What `contexts.delete` does to a key family (see the module comment). */
export type ChatDeleteClassification =
  | { readonly onChatDelete: 'purged' }
  | { readonly onChatDelete: 'content-free'; readonly reason: string }
  | { readonly onChatDelete: 'kept'; readonly reason: string };

/** One key family Bureau writes: its prefix and what a chat's delete does to it. */
export type ReservedKeyFamily = ChatDeleteClassification & { readonly prefix: string };

const purged = (prefix: string): ReservedKeyFamily => ({ prefix, onChatDelete: 'purged' });
const contentFree = (prefix: string, reason: string): ReservedKeyFamily => ({
  prefix,
  onChatDelete: 'content-free',
  reason,
});
const kept = (prefix: string, reason: string): ReservedKeyFamily => ({
  prefix,
  onChatDelete: 'kept',
  reason,
});

/** Every key family Bureau writes, with what a chat's delete does to it. */
export const BUREAU_RESERVED_KEY_FAMILIES: readonly ReservedKeyFamily[] = [
  kept(
    'asset:v1:',
    'a managed asset is its principal’s, not a chat’s: its record holds media facts, holders and retention, and its bytes live in asset storage; the delete releases the chat’s claims (asset-claim-reconciliation.ts) and an asset nothing holds expires by its own retention',
  ),
  kept(
    'audit:v1:',
    'the audit entries of the chat’s runs are kept as proof the runs happened, with their content redacted in place (AuditTrail.redact), and a late entry is redacted as it is written',
  ),
  contentFree('audit-dedupe:v1:', 'a marker naming the audit key a dedupe key was recorded at'),
  contentFree('audit-retention:v1:', 'the audit trail’s retention bookkeeping'),
  contentFree('audit-sequence:v1:', 'the audit trail’s sequence counter'),
  purged('bureau-a2a-context:v1:'),
  contentFree(
    'bureau-a2a-push:v1:',
    'a push notification checkpoint: the caller’s URL, token fingerprint and cursor',
  ),
  contentFree('bureau-a2a-push-fingerprint-key:v1', 'the secret push fingerprints are keyed with'),
  kept(
    'bureau-a2a-task:v1:',
    'a task’s A2A record (ids, incarnation) is kept beside the task record, with its history emptied by the purge (clearContext), so GetTask still answers the task’s state',
  ),
  kept('bureau-agent-revision:v1:', 'an agent’s definition history, not a chat’s'),
  contentFree('bureau-agent-run:v1:', 'the hash of the definition a run started with'),
  kept(
    'bureau-agent-snapshot:v1:',
    'an agent’s definition as a run started with it, shared by runs',
  ),
  kept('bureau-agent-version:v1:', 'an agent’s version record, not a chat’s'),
  purged('bureau-catalog-run:'),
  purged('bureau-chat-spend:v1:'),
  purged('bureau-child:parent:'),
  purged('bureau-child:record:'),
  contentFree('bureau-delegation:grant:', 'a delegation’s ids and budget amounts'),
  contentFree('bureau-delegation:ledger:', 'a delegation’s ids and spent amounts'),
  kept('bureau-goal:record:', 'a goal’s record; a goal runs in its own session, never in a chat'),
  purged('bureau-peer-call:record:'),
  purged('bureau-removed-surfaces:v1:'),
  purged('bureau-resolved-review:v1:'),
  kept('bureau-schedule-transition:', 'a schedule’s pending transition, not a chat’s'),
  purged('bureau-secret-answer:v1:'),
  purged('bureau-surface:v1:'),
  contentFree(
    'bureau-task-context:v1:',
    'the index from a context to its task ids, which every purge pass reads to find a run admitted after the delete began',
  ),
  kept(
    'bureau-task-listing:v4:',
    'a listing’s page snapshot of task views (ids, statuses, origins, and a failed task’s status message), which its page token outlives by fifteen minutes at most (TASK_LISTING_LIFETIME_MILLISECONDS) and the sweep then deletes',
  ),
  kept(
    'bureau-task:v1:',
    'a task’s record (ids, status, cleanup) is kept as proof the task happened; its history is emptied at the delete (COR-1481) and its settlement’s message and answer text are dropped by the purge',
  ),
  kept('bureau-workflow-cancelled-run:v1:', 'a workflow run’s cancellation record, not a chat’s'),
  kept('bureau-workflow-schedule:', 'a workflow’s schedule, not a chat’s'),
  kept('bureau-workflow-snapshot:v1:', 'a workflow’s definition snapshot, not a chat’s'),
  contentFree(
    'chat-content-purge-pending:v1:',
    'the record of a purge that is owed: the chat’s id, incarnation and run ids',
  ),
  contentFree(
    'chat-content-purge-tombstone:v1:',
    'the fence a purged run’s late writers are refused by: the run id and when it was purged',
  ),
  contentFree('ag-ui-lease:v1', 'an AG-UI stream’s lease: ids and an expiry'),
  purged('command-ledger:a2a-send:v1'),
  contentFree(
    'command-ledger:ag-ui-resume:v1',
    'a resume’s receipt: thread, run and interrupt ids and their outcomes',
  ),
  contentFree(
    'command-ledger:fork:v1',
    'a fork’s receipt: the new context id, a model override and an effort',
  ),
  purged('command-ledger:tasks-respond:v1'),
  purged('command-ledger:v1'),
  purged('outbox-dedupe:'),
  contentFree('outbox-dedupe-reconciliation-pending', 'the outbox reconciliation’s own marker'),
  kept('proposal:', 'a self-improvement proposal about a skill, not a chat’s'),
  purged('review-decision:v1'),
  contentFree('session-deletion-owner:v1:', 'who deleted a session, by principal'),
  contentFree(
    'session-input-identity:v1',
    'the binding of a caller’s input id to a session and incarnation; no payload',
  ),
  purged('session-input-open:v2:'),
  kept('settings', 'the Bureau’s settings, not a chat’s'),
  kept('skill-source:', 'a skill’s source, not a chat’s'),
  kept('tool-source:', 'a tool’s source, not a chat’s'),
  kept('skill:', 'a skill’s record, not a chat’s'),
  contentFree('steering-key:v1', 'the binding of a steering command id to its log position'),
  contentFree(
    'steering-log:v1',
    'a session’s steering commands: model, effort and policy choices and the ids they were admitted under; no free text',
  ),
  contentFree(
    'webhook-delivery:v1:',
    'a delivery’s target URL, run id, attempt counts and transport error; the payload is not stored',
  ),
  kept('worker-deployment:', 'a worker deployment’s record, not a chat’s'),
];

/**
 * Every storage key prefix Bureau writes, in the order of {@link BUREAU_RESERVED_KEY_FAMILIES}.
 * An entry matches a key by `startsWith`.
 */
export const BUREAU_RESERVED_KEY_PREFIXES: readonly string[] = BUREAU_RESERVED_KEY_FAMILIES.map(
  (family) => family.prefix,
);

/**
 * The key families of the durable engine (Weft) and the session store (Operative) that a chat's
 * runs write into the storage a Bureau shares with them, with what a chat's delete does to each.
 * They are those packages' to reserve, not Bureau's (`WEFT_RESERVED_KEY_PREFIXES` names Weft's),
 * but the purge of a deleted chat reaches them too, so they are classified here. A family a chat
 * writes that is in neither list fails `chat-delete-purge-content.test.ts`.
 */
export const SHARED_KEY_FAMILIES_OF_A_CHAT: readonly ReservedKeyFamily[] = [
  // Operative: the session body, its summary index and its outbox, deleted by the session store;
  // the durable run cursors, steps and transcripts, purged with the run's workflow.
  purged('agent-session'),
  purged('durable-run:'),
  contentFree(
    'session-input-deliveries:v1:',
    'Operative’s record of which run is delivering each admitted input: run ids, claim times and promotion ids, under its own retention',
  ),
  // Weft: the run's workflow state, checkpoints, headers, indexes, signals and logs, purged by
  // exact id (`purgeWorkflow`'s delete set).
  purged('wf:'),
  purged('wf-idx-'),
  purged('wf-cleanup:'),
  purged('wf-cleanup-needed:'),
  purged('wf-headers:'),
  purged('wf-has-services:'),
  purged('wf-terminal:'),
  purged('wf-deadline:'),
  purged('wf-delayed:'),
  purged('wf-finalizer-state:'),
  purged('wf-teardown-needed:'),
  purged('wf-teardown-succeeded:'),
  purged('timer-idx:'),
  purged('ev:'),
  purged('log:'),
  purged('log-counter:'),
  purged('watch-event:'),
  purged('sig:'),
  purged('sigres:'),
  purged('sigseq:'),
  purged('review:'),
  purged('offload:'),
  purged('archive:'),
  purged('blob:'),
  purged('state:'),
  purged('tool-effect:'),
  purged('upk:'),
  purged('upd:'),
  purged('uph:'),
  purged('upr:'),
  purged('actrec:'),
  purged('async-act:'),
  purged('attr:'),
  purged('idx:'),
  purged('tag:'),
  purged('child-by-parent:'),
  contentFree(
    'wf-gen:',
    'Weft’s permanent generation fence of a run id, bumped at purge so the id is never reused',
  ),
  contentFree('wf-owner-epoch:', 'Weft’s permanent ownership epoch of a run id, rotated at purge'),
  contentFree('wf-owner-holder:', 'which process holds a run’s ownership'),
  contentFree('wf-concurrency:', 'the engine’s concurrency counters'),
  contentFree('wf-concurrency-holder:', 'which run holds a concurrency slot'),
  kept(
    'wf-teardown-deadletter:',
    'Weft’s record of a finalizer that leaked a resource, kept past purge as the operator’s evidence',
  ),
  // Weft: the durable event history, purged by owner (`run:<id>`, `session:<id>`).
  purged('fleet-event:'),
  purged('fleet-event-by-workflow:'),
  contentFree('fleet-event-tail', 'the feed’s tail sequence'),
  contentFree('fleet-event-watermark', 'the feed’s retention watermark'),
  // Weft: the chat's session-input mailbox, purged whole; its header stays sealed.
  purged('appcmd:'),
  purged('appready:'),
  purged('appseq:'),
  purged('appterm:'),
  purged('appidem:'),
  purged('appprobe:'),
  contentFree(
    'appmbx:',
    'a mailbox’s header: its ids and counters; a purged mailbox keeps a sealed header that refuses admissions',
  ),
  // Weft: the activity catalog, shared by every run.
  kept('catalog-entry:', 'the engine’s activity catalog, shared by every run'),
  kept('catalog-active:', 'the engine’s active catalog set, shared by every run'),
  contentFree('weft:', 'Weft’s persisted schema version'),
];
