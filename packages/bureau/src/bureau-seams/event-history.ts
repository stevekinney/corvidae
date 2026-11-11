/**
 * Event history (COR-2376 slice S1): `Bureau.eventHistory` and `Bureau.subscribeEventHistory`,
 * with the owner authorization both apply. Built by `constructBureau` and reached only through
 * `createBureau`.
 */
import type {
  DurableEventEnvelope,
  DurableEventGap,
  DurableEventOwner,
  DurableEventPage,
  Subscription,
} from '@lostgradient/operative';
import type { AgentDefinitions } from '../agent-catalog';
import {
  DURABLE_HISTORY_GAP_KIND,
  type DurableEventHistory,
  type DurableEventHistoryPageOptions,
  type DurableEventHistorySubscribeOptions,
  deletionMarkerKindFor,
} from '../durable-event-history';
import { serializeUnknownError } from '../serialization';
import { isSessionHistoryReadAuthorized } from '../session-authority';
import type {
  EventHistoryDeletedAggregateOutcome,
  EventHistoryNotFoundOutcome,
  EventHistoryUnsupportedOutcome,
} from '../bureau-types/common';
import type { BureauCore } from './core';

/** The callables event history reads from elsewhere in `constructBureau`. */
export interface EventHistoryPeers {
  /** The principal recorded as a run's owner, as `Bureau.ownerOf` reads it. */
  runOwner: (runId: string) => Promise<string | undefined>;
  /** The principal recorded as a schedule's owner. */
  scheduleOwner: (scheduleId: string) => Promise<string | undefined>;
}

/** Builds the durable event history reads of one Bureau. Synchronous, and registers nothing. */
export function createEventHistoryReads<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: EventHistoryPeers,
) {
  const { runtime, diagnose } = core;

  /**
   * Whether `principal` may read `owner`'s durable history right now: the one
   * rule `eventHistory()` and `subscribeEventHistory()` both apply, so a feed
   * that cannot be paged by a stranger cannot be tailed by one either.
   *
   * Each kind compares the caller with that kind's owner of record, read the way
   * {@link Bureau.ownerOf} reads it (COR-718), and fails closed when there is
   * none to read, so an id cannot be probed:
   *
   * - run: the owner `runAttribution` records for it (`anonymous:local` for a
   *   record with none), and no one once the run is deleted (see
   *   `resolveEventHistory`).
   * - goal: only a principal `bureau.goals.get` shows the goal to.
   * - session: `isSessionHistoryReadAuthorized`: only the session's owner, and
   *   no one when the session does not exist (its history is then a deleted
   *   aggregate, readable only by a caller that states no principal). A malformed
   *   owner is closed.
   * - schedule: the schedule's owner (`ScheduledAgentRunInput.principal`).
   *
   * Read fresh on every call, because ownership is not stable for a live feed:
   * a goal, run, or schedule may not exist yet when a subscription starts, and a
   * session id can be recreated under another owner.
   */
  async function ownerReadableBy(owner: DurableEventOwner, principal: string): Promise<boolean> {
    switch (owner.kind) {
      case 'run':
        // Read the way `ownerOf` reads it, and closed for a run that no longer exists.
        return (await peers.runOwner(owner.id)) === principal;
      case 'goal':
        return (await core.goalsComposition.goals.get(owner.id, { principal })) !== undefined;
      case 'session': {
        // A session that does not exist is closed, not open: its history is
        // readable only without a principal (see `resolveEventHistory`).
        if (!runtime.sessionStore) return false;
        const session = await runtime.sessionStore.load(owner.id);
        return session !== undefined && isSessionHistoryReadAuthorized(session.metadata, principal);
      }
      case 'schedule':
        return (await peers.scheduleOwner(owner.id)) === principal;
    }
  }

  /**
   * `Bureau.subscribeEventHistory` for a caller that stated a principal. The
   * store's subscription is opened at once (so an invalid cursor still throws
   * synchronously, as for a trusted caller), but nothing it produces reaches
   * `listener` until `ownerReadableBy` says so, and it says so again for every
   * event, in order, through one serialized chain: an owner that did not exist
   * when the subscription began (a goal created afterwards, a run dispatched
   * afterwards) is authorized by the first event that names it, and an owner
   * whose authority changes mid-feed stops being delivered. An event the
   * principal may not read is dropped, never queued, and a failed check is
   * a denial. The subscription stays open and silent rather than reporting a
   * refusal, so it cannot be used to tell an owner that exists from one that
   * does not.
   */
  function subscribeAuthorized(
    history: DurableEventHistory,
    owner: DurableEventOwner,
    listener: (event: DurableEventEnvelope) => void,
    principal: string,
    subscribeOptions: DurableEventHistorySubscribeOptions | undefined,
  ): Subscription {
    let delivery: Promise<void> = Promise.resolve();
    // COR-718 — a session id's history holds every incarnation of the id, and the
    // live session's owner is not an earlier incarnation's owner. Each event of a
    // session is therefore judged against the session that is live when it is
    // judged: it must exist and be the subscriber's, and the event must have been
    // recorded for that very incarnation. An event recorded for none is never
    // delivered to a principal. Nothing else separates the incarnations: not a
    // marker between them, which an expiry never writes, and not the state of the
    // outbox. The one exception is the gap event the stream synthesizes when
    // retention has passed the subscriber (COR-1477): it is not a recorded event
    // of any incarnation, carries nothing owner-scoped, and is the owner's only
    // way to learn that history was lost, so it reaches an owner of the live session.
    const deliver = async (event: DurableEventEnvelope, incarnation: string | undefined) => {
      if (owner.kind === 'session') {
        try {
          const live = await runtime.sessionStore?.load(owner.id);
          if (!live || !isSessionHistoryReadAuthorized(live.metadata, principal)) return;
          if (
            event.kind !== DURABLE_HISTORY_GAP_KIND &&
            (incarnation === undefined || incarnation !== live.incarnation)
          ) {
            return;
          }
        } catch (error) {
          // Only the event in hand is lost; the next event loads the session afresh.
          diagnose({
            level: 'error',
            scope: 'durable-event-history',
            message: `[bureau] Could not load session:${owner.id} for a subscriber; its event "${event.kind}" was not delivered: ${serializeUnknownError(error)}`,
            cause: error,
          });
          return;
        }
      }
      // A session was judged above, against the session live at the time. The other kinds
      // are judged by their owner of record.
      let readable = owner.kind === 'session';
      try {
        if (owner.kind !== 'session') readable = await ownerReadableBy(owner, principal);
      } catch (error) {
        diagnose({
          level: 'error',
          scope: 'durable-event-history',
          message: `[bureau] Could not authorize ${owner.kind}:${owner.id} for a subscriber; its event "${event.kind}" was not delivered: ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
      if (!readable || inner.closed) return;
      try {
        listener(event);
      } catch (error) {
        diagnose({
          level: 'error',
          scope: 'durable-event-history',
          message: `[bureau] Listener threw for ${owner.kind}:${owner.id} event "${event.kind}": ${serializeUnknownError(error)}`,
          cause: error,
        });
      }
    };
    const inner = history.subscribeEventHistory(
      owner,
      (event, incarnation) => {
        delivery = delivery.then(() => deliver(event, incarnation));
      },
      subscribeOptions,
    );
    return inner;
  }

  /**
   * AB-313 — authorization and deleted-aggregate handling layered over
   * `eventHistoryInstance.page()`. This wrapper (not `page()` itself, which
   * knows nothing about sessions, runs, or principals) is the only place
   * that can answer "is `principal` allowed to see this owner's history" —
   * it has `runtime.sessionStore` and `store` in closure, neither of which
   * `DurableEventHistory` carries.
   *
   * Authorization (AB-42's ordering: checked before anything else, so an
   * unauthorized caller cannot learn a run/session exists) runs ONLY when
   * `options.principal` is provided AND the owner's live record still
   * exists — a caller that omits `principal` (an internal/trusted caller,
   * or a privileged gateway connection) skips it entirely, and an owner
   * with NO recorded principal is open (matches every other session verb's
   * "no recorded authority" rule). A denial reports the same
   * not-found-shaped outcome `submitSessionInput` uses.
   *
   * Deleted-aggregate detection is evidence-based, not existence-based: it
   * looks for the owner's own deletion marker EVENT inside the page that
   * was just fetched (`session.deleted` for a session, `run.removed` for a
   * run), never merely "the live record is missing" — a durable event can
   * legitimately exist for an id that never had (or no longer has) a live
   * record for other reasons (e.g. a synthetic action recorded before a
   * session was ever saved), and reporting deleted-aggregate for those
   * would be a false positive; a genuinely fresh, never-recorded id must
   * still read back as an ordinary empty page.
   *
   * A SESSION owner adds one more override on top of that evidence (AB-372,
   * Codex review finding, PR #580, "Ignore prior deletion markers while a
   * reused session is live"): a session id is explicitly supported to be
   * RECREATED after deletion (`create-bureau.test.ts`'s "does not coalesce
   * a deleteSession call for a session RECREATED with the same id"), and
   * `createDurableEventProducer`'s own session.deleted listener does not
   * prune a prior incarnation's marker from the durable history a recreated
   * session shares with its predecessor — by design, not for lack of a
   * mechanism: `SessionDeletedEvent` carries a real per-incarnation
   * `incarnation` identity since AB-384, but AB-87's retention posture is no
   * silent data loss, so a settled incarnation's own durable facts stay
   * queryable forever, exactly like a run's. Evidence of a deletion
   * that once happened is therefore not sufficient on its own once a
   * session id has been reused — this function ALSO checks whether
   * `owner.id` currently names a LIVE session record before reporting
   * `deleted-aggregate`: a live record wins, and the ordinary page is
   * returned instead (still carrying that historical marker among its
   * events — nothing is hidden, only the deleted-aggregate OUTCOME is
   * suppressed). A run owner has no equivalent override: run ids are freshly
   * minted, never reused, so `run.removed` evidence is never stale in the
   * same way.
   *
   * A schedule owner is authorized the way a goal's is (COR-718): only the
   * schedule's owner of record reads its history. Schedule owners have no
   * deletion concept in this codebase today, so they go on to `page()`.
   *
   * AB-385 (coordinator ruling, 2026-09-08, closing the KNOWN LIMITATION
   * this comment used to document — Codex review finding, PR #580, "Detect
   * deletion markers beyond the requested page"): evidence of a deletion no
   * longer comes from scanning the ONE page `history.page()` returns under
   * `options`' own limit (100 by default) — a session or run with more
   * durable events than that limit could carry its own deletion marker on a
   * LATER page this function never inspected, reporting an ordinary page
   * instead of `deleted-aggregate` for a genuinely deleted owner. Evidence
   * now comes from `history.latestDeletionMarker(owner)`, a dedicated read
   * over the ENTIRE retained feed, independent of `since`/`limit` — the
   * classification below no longer depends on the caller's own pagination
   * parameters. The requested page's own `events`/`hasMore` are still
   * returned verbatim on the `deleted-aggregate` outcome; only the OUTCOME
   * classification uses the independent read, matching both marker kinds.
   */
  async function resolveEventHistory(
    history: DurableEventHistory,
    owner: DurableEventOwner,
    requestOptions?: DurableEventHistoryPageOptions,
  ): Promise<
    | DurableEventPage
    | DurableEventGap
    | EventHistoryNotFoundOutcome
    | EventHistoryDeletedAggregateOutcome
  > {
    const principal = requestOptions?.principal;

    if (owner.kind === 'run' && principal !== undefined) {
      // AB-313 — fail CLOSED whenever this run's ownership cannot be
      // verified against `runAttribution` (`request.principal`, AB-54's
      // best-effort attribution map), rather than treating an absent entry
      // as open. `runAttribution` is cleared by `deleteRun` (never
      // reinstated), so a deleted run reads identically to one that
      // legitimately never had a principal — the two cases cannot be told
      // apart from this map alone. A run recovered across a process
      // restart is no longer in the same bucket: AB-359 rehydrates this
      // map's `principal` from the session's durably persisted
      // `lastRunOwningPrincipals` entry (`reattachRecoveredRun`), so a
      // recovered run's REAL owner reads exactly as it did before the
      // restart, and a recovered run that was genuinely never dispatched
      // with a principal stays exactly as unresolved as it was live.
      // Failing open for a deleted or genuinely-unattributed run would let
      // an unauthenticated caller retrieve durable history for a run they
      // never owned, including through the deleted-aggregate 200 path
      // (copilot review, PR #551). Omitting `principal` entirely still
      // skips this check (an internal/trusted caller), matching every
      // other owner kind's convention.
      if (!(await ownerReadableBy(owner, principal))) {
        return { outcome: 'not-found' };
      }
    }

    // COR-851 — a goal's events are as private as the goal itself. The same
    // rule `bureau.goals.get` applies: omitting `principal` is a trusted call,
    // and a mismatch reads as `not-found`. A goal that cannot be read at all
    // (never created, or unreadable) fails closed for the same reason a run
    // with unverifiable ownership does, so its id cannot be probed. Goal ids
    // are never reused and a goal is closed, not deleted, so the owner read
    // here cannot change under the page read below, and a goal owner has no
    // deletion marker. Checked before anything else, so neither a gap nor an
    // owner-write wait is observable to a caller who may not see the goal.
    if (
      owner.kind === 'goal' &&
      principal !== undefined &&
      !(await ownerReadableBy(owner, principal))
    ) {
      return { outcome: 'not-found' };
    }

    // COR-718 — a schedule's history is as private as the schedule: only its owner
    // reads it, and one that cannot be read at all (never created) fails closed
    // for the same reason a run with unverifiable ownership does.
    if (
      owner.kind === 'schedule' &&
      principal !== undefined &&
      !(await ownerReadableBy(owner, principal))
    ) {
      return { outcome: 'not-found' };
    }

    // AB-372 (Codex review findings, PR #580 — see the running history in
    // this comment for why each earlier shape of this check was
    // insufficient) — session authorization is checked TWICE, deliberately,
    // never once: a PRE-page check (immediately below, BEFORE this function
    // does any other work) and a POST-page check (after `history.page()`
    // resolves, before this function decides what to return). Both are
    // necessary, and neither subsumes the other:
    //
    // - The PRE-page check exists ONLY to protect the `DurableEventGap`
    //   outcome — `page()` can return a gap instead of an ordinary page
    //   (retention has advanced past `since`), and that outcome is returned
    //   immediately, before any post-page check would ever run. Without
    //   this, an unauthorized caller whose `since` lands before the
    //   retention floor would get the gap's own retention metadata instead
    //   of the documented not-found-shaped denial ("Authorize sessions
    //   before returning history gaps"). Gated on `principal !== undefined`
    //   — an internal/trusted caller has nothing to authorize, and skipping
    //   the load entirely for that case avoids an unnecessary durable-store
    //   round trip and a spurious rejection if the session store happens to
    //   be unavailable ("Skip the authorization load when no principal is
    //   supplied"). Deliberately placed BEFORE `waitForActiveWrites` below
    //   ("Authorize sessions before waiting on producer writes") — an
    //   unauthorized caller must get the documented not-found denial
    //   immediately, never delayed behind (or have its response latency
    //   reveal) an unrelated owner-write wait it was never entitled to see
    //   the result of anyway.
    // - The POST-page check re-loads the session record FRESH, unconditionally
    //   for every session owner (not gated on whether a deletion marker
    //   happens to appear on the page), and re-authorizes against THAT
    //   record before this function returns anything past this point. A
    //   session id can be recreated, under a DIFFERENT authority, at any
    //   point between the pre-page read and `page()` resolving — the
    //   pre-page check alone would still let that later state slip through:
    //   nested only under "the page contains a `session.deleted` marker"
    //   left every ordinary-page return unchecked whenever a `since` cursor
    //   or limit paged around that marker, or when the session was
    //   genuinely never deleted at all before being recreated with new
    //   ownership mid-read ("Reauthorize sessions after every history
    //   read"). This SAME freshly-loaded record is also what the
    //   deletion-marker branch below uses for its "is this owner still
    //   live" check — one load serves both concerns, since by construction
    //   it is the freshest state either one could ever act on.
    //
    // Omitting `principal` entirely always skips authorization (an
    // internal/trusted caller), matching every other owner kind's
    // convention. A session is readable by every principal that owned a run
    // on it (`lastRunOwningPrincipals`, COR-1382) as well as by whoever the
    // recorded authority names; a session with no recorded authority is
    // still open, and malformed authority metadata fails closed, per
    // `isSessionHistoryReadAuthorized`'s own documented rule.
    let readIncarnation: string | undefined;
    if (owner.kind === 'session' && principal !== undefined && runtime.sessionStore) {
      const preSession = await runtime.sessionStore.load(owner.id);
      // COR-718: a caller that states a principal reads only a live session it owns.
      // History is keyed by session id alone, so a deleted session has no owner left
      // to compare, and its former owner is no exception; only a trusted caller
      // (no principal) reads a deleted session's history.
      if (!preSession || !isSessionHistoryReadAuthorized(preSession.metadata, principal)) {
        return { outcome: 'not-found' };
      }
      readIncarnation = preSession.incarnation;
    }

    // AB-372 (Codex review finding, PR #580, "Wait for the deletion
    // projection before serving history"): every write into `history` from
    // `createDurableEventProducer` is fire-and-forget from its own
    // dispatching caller's perspective (`deleteSession`/`deleteRun` return
    // as soon as the synchronous event dispatch completes, not once the
    // durable write actually commits) — so a caller that awaits
    // `deleteSession(id)` and immediately calls `eventHistory` for the same
    // owner could otherwise read an ordinary page a heartbeat before the
    // deletion's own durable write lands. Awaiting this owner's in-flight
    // writes first (a snapshot, never an open-ended wait — see
    // `waitForActiveWrites`'s own doc comment) closes that race, mirroring
    // `AuditTrail.query()`'s identical `activeWritesByRunId`-based fix
    // (AB-228, PR #566). A caller with no `durableEventProducerInstance`
    // (no persistent storage backend) never reaches this function at all —
    // `Bureau.eventHistory` short-circuits to `'unsupported-capability'`
    // first — so this is always defined whenever `history` is.
    await core.durableEventProducerInstance?.waitForActiveWrites(owner);

    // COR-718 — a principal-stated read of a session keeps only the events recorded
    // for the live incarnation (`readIncarnation`); every other incarnation's events,
    // and any recorded for none, are left out by the store, whatever `since` and
    // `limit` the caller passes.
    const page = await history.page(
      owner,
      readIncarnation === undefined
        ? requestOptions
        : { ...requestOptions, incarnation: readIncarnation },
    );
    if ('outcome' in page) {
      // AB-372 (Codex review finding, PR #580, "Reauthorize the session
      // before returning a post-wait gap"): the pre-page check above ran
      // BEFORE `waitForActiveWrites`, so it authorized a snapshot that is
      // now stale by exactly the span of that wait — a session recreated
      // for a different, unauthorized principal during the wait would
      // otherwise ride the ALREADY-PASSED pre-page check straight through
      // to a raw `DurableEventGap`, leaking retention metadata to a caller
      // who should see nothing but `not-found`. Reauthorize against a
      // fresh load, right here, before this gap ever reaches the caller —
      // this is a second, independent check from the pre-page one above
      // and from the post-page one below (which never runs on this
      // branch, since a gap returns before reaching it).
      if (owner.kind === 'session' && principal !== undefined && runtime.sessionStore) {
        const gapSession = await runtime.sessionStore.load(owner.id);
        if (!gapSession || !isSessionHistoryReadAuthorized(gapSession.metadata, principal)) {
          return { outcome: 'not-found' };
        }
      }
      return page; // a DurableEventGap
    }

    // COR-718 — the page holds the live incarnation's events only (see the read
    // above). The live session is read again once the page is in hand, because the
    // id can be deleted or recreated while the page is read: the session must still
    // be there, still the same incarnation, and still the caller's.
    if (owner.kind === 'session' && principal !== undefined && runtime.sessionStore) {
      const liveSession = await runtime.sessionStore.load(owner.id);
      if (
        !liveSession ||
        liveSession.incarnation !== readIncarnation ||
        !isSessionHistoryReadAuthorized(liveSession.metadata, principal)
      ) {
        return { outcome: 'not-found' };
      }
      return page;
    }

    // AB-385 — evidence-based, independent of `options.since`/`options.limit`.
    // `pageHasDeletionMarker` is the ORIGINAL AB-313 check (does the page
    // just fetched contain the marker); `latestDeletionMarker` widens it to
    // the ENTIRE retained feed, not merely this one page. Both are
    // consulted, deliberately OR'd together rather than the independent
    // scan alone replacing the page check (Codex review, PR #591,
    // "Preserve deletion evidence already returned by the page"): retention
    // can advance between `history.page()` resolving above and
    // `latestDeletionMarker()` running here, aging the marker below the
    // feed's floor in the span between the two calls — `latestDeletionMarker`
    // would then no longer see it, even though `page.events` (a snapshot
    // taken a moment earlier, while the marker was still retained) still
    // carries it. Regressing to an ordinary-page classification under that
    // race would be strictly worse than AB-313's original page-only
    // detection ever was.
    const deletionMarkerKind = deletionMarkerKindFor(owner.kind);
    const pageHasDeletionMarker =
      deletionMarkerKind !== undefined &&
      page.events.some((event) => event.kind === deletionMarkerKind);
    // Scan-avoidance (Codex review, PR #591, "Avoid replaying the entire
    // fleet for every history page"): `latestDeletionMarker`'s full-feed
    // scan is skipped whenever the page already fetched above PROVES the
    // owner's complete retained history — no `since` cursor (nothing before
    // the beginning was excluded) and `hasMore: false` (nothing after this
    // page remains) — because in that case `pageHasDeletionMarker` above is
    // already the complete, exact answer; the independent scan could not
    // possibly find a marker sitting outside the page's own window if there
    // IS no "outside" for this call. Every other call (a `since` cursor, a
    // truncated `hasMore: true` page, or a fresh, still-empty owner where
    // both are true but a fast internal/trusted answer is fine) still pays
    // for the independent scan.
    const pageProvesCompleteHistory = requestOptions?.since === undefined && !page.hasMore;
    const hasDeletionMarker =
      pageHasDeletionMarker ||
      (!pageProvesCompleteHistory && (await history.latestDeletionMarker(owner)) !== undefined);

    // Only load the live session record post-page when it can actually
    // change the outcome: either a `principal` needs reauthorizing against
    // it (the recreation race described above), or a deletion marker on
    // this page needs a liveness check to know whether it is current or
    // stale (below). Neither applies when there's no marker AND no
    // principal to reauthorize — an internal/trusted caller reading an
    // ordinary page gains nothing from this extra `sessionStore.load`, so
    // skip it rather than pay for a lookup no branch below will use.
    const liveSession =
      owner.kind === 'session' && runtime.sessionStore && hasDeletionMarker
        ? await runtime.sessionStore.load(owner.id)
        : undefined;

    // A currently-live session record is authoritative over a stale
    // deletion marker from a PRIOR incarnation of a recreated id — this
    // owner presently exists, so it is not deleted right now, regardless of
    // what its durable history contains (its historical events, including
    // that marker, are still returned in the page; only the outcome
    // classification is suppressed). `liveSession` is already authorized
    // above (or the caller is internal/trusted) by the time this runs.
    if (owner.kind === 'session' && hasDeletionMarker && liveSession) {
      return page;
    }

    if (hasDeletionMarker) {
      return { outcome: 'deleted-aggregate', owner, ...page };
    }
    return page;
  }

  /**
   * The durable event history of a task, context, or schedule, which `tasks.events`,
   * `contexts.events`, and `schedules.events` narrow to their owner kind.
   */
  function readEventHistory(
    owner: DurableEventOwner,
    eventHistoryOptions?: DurableEventHistoryPageOptions,
  ): Promise<
    | DurableEventPage
    | DurableEventGap
    | EventHistoryUnsupportedOutcome
    | EventHistoryNotFoundOutcome
    | EventHistoryDeletedAggregateOutcome
  > {
    if (!core.eventHistoryInstance) {
      return Promise.resolve({
        outcome: 'unsupported-capability',
        reason: 'no-persistent-storage',
      });
    }
    return resolveEventHistory(core.eventHistoryInstance, owner, eventHistoryOptions);
  }

  /**
   * Subscribes to an owner's durable event history, a replay from the cursor and then the live
   * tail, which each namespace's `subscribeEvents` narrows to its owner kind.
   */
  function subscribeToEventHistory(
    owner: DurableEventOwner,
    listener: (event: DurableEventEnvelope) => void,
    subscribeOptions?: DurableEventHistorySubscribeOptions,
  ): Subscription {
    if (!core.eventHistoryInstance) {
      // No persistent storage backend: nothing to subscribe to. Mirrors
      // `eventHistory()`'s graceful `'unsupported-capability'` outcome,
      // projected onto `Subscription`'s synchronous-return shape (which
      // carries no room for an outcome value) as an already-closed
      // subscription that never delivers — a caller that must
      // distinguish "unsupported" from "supported but empty" calls
      // `eventHistory()` first.
      return { unsubscribe() {}, closed: true };
    }
    const principal = subscribeOptions?.principal;
    // An omitted principal is a trusted caller, as it is for `eventHistory()`.
    return principal === undefined
      ? core.eventHistoryInstance.subscribeEventHistory(owner, listener, subscribeOptions)
      : subscribeAuthorized(
          core.eventHistoryInstance,
          owner,
          listener,
          principal,
          subscribeOptions,
        );
  }

  return { readEventHistory, subscribeToEventHistory };
}
