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
 *   chat and of its runs (`chat-content-purge.ts`). The class test must populate it, or the entry
 *   says why it is `unexercised`;
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
  | {
      readonly onChatDelete: 'purged';
      /**
       * Why the class test (`chat-delete-purge-content.test.ts`) does not populate the family, when
       * its chats do not. The test fails a `purged` family it did not populate unless this says why,
       * and fails a family that carries this reason but was populated, so the reason cannot go stale.
       */
      readonly unexercised?: string;
    }
  | { readonly onChatDelete: 'content-free'; readonly reason: string }
  | { readonly onChatDelete: 'kept'; readonly reason: string };

/** One key family Bureau writes: its prefix and what a chat's delete does to it. */
export type ReservedKeyFamily = ChatDeleteClassification & { readonly prefix: string };

const purged = (prefix: string): ReservedKeyFamily => ({ prefix, onChatDelete: 'purged' });
/** A `purged` family the class test's chats do not write; the reason says what would. */
const purgedButUnexercised = (prefix: string, unexercised: string): ReservedKeyFamily => ({
  prefix,
  onChatDelete: 'purged',
  unexercised,
});
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
  // The asset service's own records (`assets/records.ts`): a managed asset is its owner's, so a
  // chat delete deletes the assets it leaves unreferenced (`chat-asset-purge.ts`) and keeps one
  // another chat, a hold or a retention claim still holds. A deleted asset's record stays as a
  // tombstone until the asset policy purges it; it holds media facts and holders, and its bytes
  // are collected with it.
  purged('asset:v1:'),
  kept(
    'asset:v1:audit:',
    'the asset service’s audit log: an event names the asset, the principal and a holder id (a session or run id), and never content or bytes; it is the proof the asset was claimed, released and deleted',
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
  purgedButUnexercised(
    'bureau-chat-spend:v1:',
    'the earlier layout of the chat spend ledger, which is only read and removed now; nothing writes it',
  ),
  purgedButUnexercised(
    'bureau-chat-spend:v2:',
    'written once a run reports a price, which the scripted models of the class test do not',
  ),
  purged('bureau-child:parent:'),
  purged('bureau-child:record:'),
  contentFree('bureau-delegation:grant:', 'a delegation’s ids and budget amounts'),
  contentFree('bureau-delegation:ledger:', 'a delegation’s ids and spent amounts'),
  kept('bureau-hook:v1:', 'a hook’s definition, the owner’s and not a chat’s'),
  purged('bureau-hook-delivery:v1:'),
  contentFree('bureau-hook-delivery-index-built:v1', 'the marker that the pending index was built'),
  contentFree(
    'bureau-hook-delivery-pending:v1:',
    'the index of pending deliveries: a delivery id and an empty value',
  ),
  kept('bureau-hook-schedule-origin:v1:', 'a hook id, no chat content'),
  kept('bureau-hook-secret:v1:', 'a hook’s sealed signing secret, not a chat’s'),
  kept('bureau-goal:record:', 'a goal’s record; a goal runs in its own session, never in a chat'),
  purged('bureau-notification:v1:'),
  contentFree(
    'bureau-process:v1:',
    'a process’s lease: an expiry time under a process id (COR-1946)',
  ),
  purgedButUnexercised(
    'bureau-peer-call:record:',
    'written by a peer call (the A2A peer tool), which the class test’s chats do not make',
  ),
  purgedButUnexercised(
    'bureau-removed-surfaces:v1:',
    'written by a surface removal, which the purge itself performs and cleans up in the same pass',
  ),
  purged('bureau-resolved-review:v1:'),
  kept('bureau-schedule-transition:', 'a schedule’s pending transition, not a chat’s'),
  purged('bureau-secret-answer:v1:'),
  purged('bureau-surface:v1:'),
  contentFree(
    'bureau-task-context:v1:',
    'the index from a context to its task ids, which every purge pass reads to find a run admitted after the delete began',
  ),
  kept(
    'bureau-task-listing:v5:',
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
  contentFree(
    'context-tombstone:v1:',
    'the fence a deleted context’s id is refused starts by: the id, its owner and when it was deleted',
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
  purgedButUnexercised(
    'session-input-open:v2:',
    'an open-input marker lives only until the input is settled, which the class test waits for',
  ),
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
 * The key families of the durable engine (Weft), the session store (Operative) and governed
 * memory that a chat's runs write into the storage a Bureau shares with them, with what a chat's
 * delete does to each. Every prefix Weft reserves (`WEFT_RESERVED_KEY_PREFIXES`) is here, whether
 * or not a chat writes it, and `reserved-key-prefixes.test.ts` fails when Weft adds one that is
 * not. They are those packages' to reserve, not Bureau's,
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
  purgedButUnexercised(
    'wf-idx-',
    'Weft’s workflow visibility index: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purged('wf-cleanup:'),
  purged('wf-cleanup-needed:'),
  purgedButUnexercised(
    'wf-headers:',
    'a workflow’s headers: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purged('wf-has-services:'),
  purged('wf-terminal:'),
  purgedButUnexercised(
    'wf-deadline:',
    'a workflow’s deadline timer: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'wf-delayed:',
    'a delayed workflow start: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'wf-finalizer-state:',
    'an engine-driven finalizer’s input: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'wf-teardown-needed:',
    'a finalizer’s owed-teardown marker: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'wf-teardown-succeeded:',
    'a finalizer’s completion marker: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'timer-idx:',
    'a workflow timer’s index entry: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purged('ev:'),
  purgedButUnexercised(
    'log:',
    'a workflow log line: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'log-counter:',
    'a workflow log’s counter: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'watch-event:',
    'a workflow watch’s event: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'sig:',
    'a pending workflow signal: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purged('sigres:'),
  purgedButUnexercised(
    'sigseq:',
    'a workflow signal sequence: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'review:',
    'Weft’s own review record: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'offload:',
    'a payload offloaded from a workflow record: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'archive:',
    'an archived workflow payload: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'blob:',
    'a workflow’s streamed blob: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'state:',
    'a workflow’s execution-scoped state (`state:execution:<run>:`): no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  kept(
    'state:workflow-scope:',
    'state shared by every run of a workflow type, written only by an application that uses `engine.atomicState().workflow`; neither Bureau nor Operative does, and it is not a chat’s, so the engine’s purge leaves it',
  ),
  purgedButUnexercised(
    'tool-effect:',
    'a tool effect receipt: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'upk:',
    'a workflow update’s request key: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'upd:',
    'a workflow update’s record: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'uph:',
    'a workflow update’s history: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'upr:',
    'a workflow update’s result: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'actrec:',
    'an activity record: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'async-act:',
    'an asynchronous activity’s record: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'attr:',
    'a workflow’s search attributes: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purgedButUnexercised(
    'idx:',
    'a search attribute’s index entry: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purged('tag:'),
  purgedButUnexercised(
    'child-by-parent:',
    'Weft’s parent-child index: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
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
  purgedButUnexercised(
    'appready:',
    'a mailbox’s ready index: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  purged('appseq:'),
  purged('appterm:'),
  purged('appidem:'),
  purgedButUnexercised(
    'appprobe:',
    'a mailbox’s sink probe: no chat of the class test writes it, and the engine’s purge deletes it by run id when one does',
  ),
  contentFree(
    'appmbx:',
    'a mailbox’s header: its ids and counters; a purged mailbox keeps a sealed header that refuses admissions',
  ),
  // Weft: families that belong to no chat's runs: the host's schedules and workers, the engine's
  // own bookkeeping, and the A2A push-notification outbox, which only a host that configures push
  // notifications writes.
  purgedButUnexercised(
    'a2a:',
    'Weft’s A2A stores: the push-notification configurations of a host that configures push (a caller’s URL and token fingerprint), which the class test does not; a chat delete deletes its tasks’ configurations through the sender (`create-bureau-handler.ts`, `session.deleted`), and Bureau’s own task store is `bureau-a2a-task:v1:`',
  ),
  purgedButUnexercised(
    'appdlv:',
    'Weft’s delivery outbox record, which carries an A2A push notification (a projection of the task’s status message and terminal reply) for a host that configures push, which the class test does not; a chat delete cancels the task’s configurations and purges their deliveries by destination (`create-bureau-handler.ts`, `session.deleted`)',
  ),
  ...[
    ['appdidem:', 'the binding of a delivery’s idempotency key to its delivery id'],
    ['appdseq:', 'the listing index of the outbox’s deliveries: delivery ids in order'],
    ['appdterm:', 'the index of the outbox’s settled deliveries: delivery ids by time'],
    ['appdue:', 'the time index of the outbox’s deliveries: delivery ids by time'],
    ['appobx:', 'the outbox header: its sequence allocator and open-delivery counter'],
  ].map(([prefix, holds]) =>
    contentFree(
      prefix!,
      `Weft’s delivery outbox, used for A2A push notifications: ${holds}; the delivery record (appdlv:) holds the payload and is purged`,
    ),
  ),
  contentFree('audit:bulk:', 'Weft’s audit of a bulk operation: its request id, filter and counts'),
  contentFree('budget:', 'Weft’s spending counters, by namespace and period'),
  contentFree('budget-charged:', 'the marker that an operation was charged to a budget once'),
  kept('catalog-removal-generation:', 'the engine’s activity catalog, shared by every run'),
  kept('catalog-tombstone:', 'the engine’s activity catalog, shared by every run'),
  contentFree('lease:', 'the engine’s ownership lease: an instance id and an epoch'),
  contentFree('liveness:', 'an engine instance’s heartbeat'),
  contentFree('ownership-mode-marker', 'the ownership mode the store was stamped with'),
  kept(
    'op:',
    'Weft’s legacy task-ledger operations, read only by its doctor; Bureau’s chat runs write none',
  ),
  kept('schedule:', 'a schedule’s definition, not a chat’s'),
  contentFree('schedule-due:', 'the time index of a schedule’s next fires'),
  contentFree(
    'schedule-missed:',
    'a record that a schedule missed an occurrence: ids and a reason',
  ),
  contentFree(
    'schedule-run-by-schedule:',
    'the index from a schedule to the workflow ids of its fires',
  ),
  contentFree('schedule-run-link:', 'the link from a fire’s workflow id to its schedule'),
  contentFree('schedule-run:', 'the record that a workflow was a schedule’s fire'),
  contentFree(
    'start-idem:',
    'the binding of a caller’s start idempotency key to the workflow it created',
  ),
  contentFree('wf-teardown:', 'a finalizer’s teardown timer: a workflow id and a time'),
  kept(
    'wf-teardown-deadletter-history:',
    'Weft’s record of every finalizer that leaked a resource, kept past purge as the operator’s evidence, like wf-teardown-deadletter:',
  ),
  kept('worker-deployment-binding:', 'a worker deployment’s record, not a chat’s'),
  kept('worker-deployment-removed:', 'a worker deployment’s record, not a chat’s'),
  kept('worker-deployment-routing:', 'a worker deployment’s record, not a chat’s'),
  kept('worker-deployment-version:', 'a worker deployment’s record, not a chat’s'),
  // Weft: the activity catalog, shared by every run.
  kept('catalog-entry:', 'the engine’s activity catalog, shared by every run'),
  kept('catalog-active:', 'the engine’s active catalog set, shared by every run'),
  contentFree('weft:', 'Weft’s persisted schema version'),
  // Operative: a goal's attempt artifacts, which a goal keeps in its own session.
  kept(
    'fresh-attempt-artifact:v1:',
    'a goal attempt’s artifacts; a goal runs in its own session, never in a chat',
  ),
  // Governed memory (`@lostgradient/memory`): what a run remembers, partitioned by the Bureau and
  // the run's owner, under the agent's collection (`createMemoryPersistHook`).
  purged('app:agent-bureau:memory:v1:'),
  // Each record's vector, per embedding profile (COR-1898), deleted with the record; beside them the
  // active-profile and profile markers name an embedder, a dimension and a generation, never content.
  purged('app:agent-bureau:memory-vectors:v1:'),
  kept(
    'app:agent-bureau:memory-governance:v1:',
    'governed memory’s ledger: its events, deletion receipts and scopes name the principal (a run id), the record ids and content digests of what was written, recalled or forgotten, and never the content; it is the proof a memory was deleted',
  ),
  kept(
    'app:agent-bureau:memory-evidence:v1:',
    'the evidence store of memory consolidation, which a host composes beside governed memory and a chat’s runs do not write; a source deletion reaches the projections derived from a record',
  ),
  kept(
    'app:agent-bureau:memory-projection:v1:',
    'the projection store of memory consolidation, which a host composes beside governed memory and a chat’s runs do not write; a source deletion reaches the projections derived from a record',
  ),
  kept(
    'app:agent-bureau:memory-transition:v1:',
    'the transition receipts of memory consolidation, which a host composes beside governed memory and a chat’s runs do not write',
  ),
];
