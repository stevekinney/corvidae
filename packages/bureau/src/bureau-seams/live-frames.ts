/**
 * Live frames (COR-2376 slice S18): the per-run frame sequence, the session identifier of a run, the
 * run-end waits, and emitting a frame to the boot buffer, the replay queue and the live listeners.
 * Built by `constructBureau` and reached only through `createBureau`; the parent and thirteen
 * seams call into it.
 */
import type { ActiveRun } from '@lostgradient/operative';
import type { AgentDefinitions } from '../agent-catalog';
import type { BureauCore } from './core';
import type { LiveTask } from '../task-registry';
import type { ServerFrame } from '../types';
import { serializeRunState } from '../serialization';

/**
 * What live frames reads from elsewhere in `constructBureau`: nothing. The factory still takes
 * `peers`, so every seam factory has the one `(core, peers)` shape the construction-window guard
 * looks for.
 */
export type LiveFramesPeers = Record<never, never>;

/** Builds the live frames of one Bureau. It reads no peer. Synchronous, and registers nothing. */
export function createLiveFrames<D extends AgentDefinitions>(
  core: BureauCore<D>,
  _peers: LiveFramesPeers,
) {
  const {
    runtimeServices,
    store,
    runSessionIdentifiers,
    diagnose,
    runAttribution,
    liveFrameListeners,
    bootFrameRunIds,
    bootFrameBuffer,
    abortingRunIds,
    runSequenceCounters,
  } = core;

  // COR-1421 — `engine.recoverAll()` resumes recovered workflows without
  // awaiting them, so recovered runs emit live frames while the rest of boot
  // still awaits, before `createBureau()` returns and a caller can subscribe.
  // Until the FIRST `frames` listener attaches, frames are
  // therefore retained: every frame emitted while a recovery pass runs (no
  // per-run attribution, so anything the pass starts is covered), and after the
  // pass the frames of the runs it reattached. Ordinary runs outside a pass are
  // never retained. That listener is replayed the retained frames in emission order
  // and the buffer closes for good. Replaying rather than deferring the resume
  // keeps delivery independent of how many awaits the boot tail contains.
  // The buffer holds at most BOOT_FRAME_BUFFER_LIMIT frames and evicts the
  // OLDEST past that, so a late subscriber sees the most recent history; a
  // reconnecting client still gets the rest through durable event history.
  // Emitter listeners are NOT replayed: they register before recovery through
  // `BureauOptions.onEvent`.
  const BOOT_FRAME_BUFFER_LIMIT = 1024;

  function nextRunSeq(runId: string): number {
    const next = (runSequenceCounters.get(runId) ?? 0) + 1;
    runSequenceCounters.set(runId, next);
    return next;
  }

  /**
   * AB-15: seeds `runSequenceCounters` for a run reattached by
   * `engine.recoverAll()` so a pre-restart client cursor cannot suppress
   * post-restart frames. `runSequenceCounters` is in-memory only and this
   * bureau instance's store is rebuilt fresh on every boot (`store.register`
   * in {@link reattachRecoveredRun} attaches to a brand-new `RunState`), so
   * without seeding, `nextRunSeq` would restart a recovered run's sequence
   * at 1 — and a browser reconnecting with a pre-restart cursor like
   * `since: 25` would have every post-restart frame (runSeq 1, 2, 3, ...)
   * filtered out by `getFramesSince`/`LiveFrameBroker`, silently losing
   * them instead of replaying them.
   *
   * Seeding from the current wall-clock time (rather than 0) guarantees the
   * new generation's sequence numbers are far larger than anything handed
   * out in a previous process's lifetime, so old cursors always compare as
   * "already behind" and every post-restart frame is delivered — at worst a
   * client sees a handful of frames it already had (harmless; frame
   * application in the UI stores is idempotent per-field, not a strict
   * just-once contract), never a silent gap.
   */
  function seedRunSeqGeneration(runId: string): void {
    runSequenceCounters.set(runId, runtimeServices.clock.now());
  }

  function getRunSessionIdentifier(runState: { activeRun: ActiveRun }): string {
    return runSessionIdentifiers.get(runState.activeRun) ?? '';
  }

  /**
   * Resolves when a run that reported `run.error` dispatches the `run.completed` (or `run.aborted`)
   * that ends it, or its result settles without one (an abandoned durable run).
   */
  function whenErroredRunEnds(activeRun: ActiveRun): Promise<void> {
    return Promise.race([
      new Promise<void>((resolve) => {
        activeRun.once('run.completed', () => resolve());
        activeRun.once('run.aborted', () => resolve());
      }),
      activeRun.result.then(
        () => undefined,
        () => undefined,
      ),
    ]);
  }

  /**
   * Resolves once `activeRun` reaches ITS OWN terminal event — mirrors the
   * exact `run.completed` / `run.aborted` / `run.error` contract gateway
   * already wires (`run-lifecycle.ts`'s module doc), so a fourth listener
   * here observes the same terminal moment as every other terminal-run
   * consumer in this file. Only safe to call for an `activeRun` known NOT
   * to have already settled (callers check `activeRuns.has(...)` or
   * `runState.status === 'running'` first) — `once()` ties the listener to
   * `activeRun`'s own completion signal, which an already-terminal run has
   * already aborted, silently dropping a listener registered after the
   * fact per DOM `addEventListener` semantics.
   */
  function whenActiveRunTerminal(activeRun: ActiveRun): Promise<void> {
    return new Promise<void>((resolve) => {
      const settle = () => resolve();
      activeRun.once('run.completed', settle);
      activeRun.once('run.aborted', settle);
      activeRun.once('run.error', settle);
    });
  }

  function emitLiveFrame(frame: ServerFrame): void {
    // AB-96 codex review — a throwing `frames` listener must not
    // abort the caller. `emitLiveFrame` is invoked synchronously from run-setup
    // call sites (e.g. the `run-started` frame fires BEFORE `store.register` and
    // the terminal listeners are installed), so an unguarded throw here would
    // propagate out of `createRun`/`reattachRecoveredRun` and leave the run
    // launched-but-untracked: the session already persisted as `running`, the
    // `ActiveRun` already started, but never registered — stuck forever. Catch
    // and log per-listener instead, matching the isolation every other fan-out
    // in this file already gives its listeners (see `disposeRegisteredStreamListeners`
    // callers, `emitter.dispatch`).
    // Retained while a recovery pass runs (any frame: scheduled fires and
    // anything else the pass starts), and afterwards for the runs it reattached,
    // until the first subscriber. Frames of ordinary runs outside a pass are
    // never retained.
    if (
      !core.liveFramesSubscribed &&
      (core.recoveryPassActive || ('runId' in frame && bootFrameRunIds.has(frame.runId)))
    ) {
      bootFrameBuffer.push(frame);
      // Overflow evicts the oldest frame, keeping the most recent history.
      if (bootFrameBuffer.length > BOOT_FRAME_BUFFER_LIMIT) bootFrameBuffer.shift();
    }
    core.frameReplayQueue?.push(frame);
    for (const listener of liveFrameListeners) {
      deliverLiveFrame(listener, frame);
    }
  }

  function deliverLiveFrame(listener: (frame: ServerFrame) => void, frame: ServerFrame): void {
    try {
      listener(frame);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'live-frames',
        message: `[bureau] frames listener threw on a "${frame.type}" frame:`,
        cause: error,
      });
    }
  }

  /**
   * COR-1481 — the task registry behind `Bureau.tasks`. The host callbacks read
   * the run store and the catalog dispatcher lazily, at call time.
   */
  function liveTaskOf(taskId: string): LiveTask | undefined {
    const runState = store.getRun(taskId);
    if (runState !== undefined) {
      const summary = serializeRunState(
        runState,
        getRunSessionIdentifier(runState),
        runAttribution.get(taskId),
      );
      const stored = runState.status;
      const phase: LiveTask['phase'] =
        stored === 'running'
          ? abortingRunIds.has(taskId)
            ? 'aborting'
            : 'running'
          : stored === 'aborting'
            ? 'aborting'
            : stored;
      return {
        phase,
        finishReason: summary.finishReason,
        error: summary.error,
        updatedAt: runState.actions.at(-1)?.timestamp,
      };
    }
    return undefined;
  }

  return {
    nextRunSeq,
    seedRunSeqGeneration,
    getRunSessionIdentifier,
    whenErroredRunEnds,
    whenActiveRunTerminal,
    emitLiveFrame,
    deliverLiveFrame,
    liveTaskOf,
  };
}
