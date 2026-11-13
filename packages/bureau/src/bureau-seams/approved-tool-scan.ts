/**
 * Approved tool scan (COR-2376 slice S19): the hook plan of a catalog run this process does not hold, and
 * the guardrail scan of an approved call's result, which runs outside the run's step. Built by
 * `constructBureau` and reached only through `createBureau`.
 */
import type { AgentDefinitions } from '../agent-catalog';
import type { BureauCore } from './core';
import { Conversation } from 'conversationalist';
import {
  type GuardrailFiring,
  type JSONValue,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  type OperativeHookMap,
  hasDefinitionResolver,
  resolvesOwnGuardrails,
  scanToolResult,
} from '@lostgradient/operative';
import type { HookRegistry } from '@lostgradient/lifecycle';
import type { PendingReview } from '../bureau-types/reviews';
import type { SessionTaintSeam } from '../session-taint-seam';
import type { ToolExecutionResult } from 'armorer';
import { catalogRunGuardrailsContext } from '../bureau-catalog-dispatch';

/**
 * What the approved tool scan reads from elsewhere in `constructBureau`: nothing. The factory still
 * takes `peers`, so every seam factory has the one `(core, peers)` shape the construction-window
 * guard looks for.
 */
export type ApprovedToolScanPeers = Record<never, never>;

/** Builds the approved tool scan of one Bureau. It reads no peer. Synchronous, and registers nothing. */
export function createApprovedToolScan<D extends AgentDefinitions>(
  core: BureauCore<D>,
  _peers: ApprovedToolScanPeers,
) {
  const { runtimeServices, runtime, diagnose, runHookPlans, runAttribution } = core;

  /**
   * COR-2299 — the hook plan a catalog agent's run this process does not hold would run with:
   * Bureau's tier for the agent, the plugin tier, and the agent's own hooks, as a dispatch composes
   * them, each tracker seeded from the session's taint (`sessionTaint`) and writing a new one back.
   * An agent that cannot be resolved falls back to Bureau's own guardrails alone, so the result is
   * still scanned.
   */
  async function catalogRunHookPlan(
    runId: string,
    sessionTaint: SessionTaintSeam,
    reviewedAgentName: string | undefined,
  ): Promise<HookRegistry<OperativeHookMap>> {
    // A run this process restarted into has no attribution; its review still names the agent.
    const agentName = runAttribution.get(runId)?.agentName ?? reviewedAgentName;
    let agent = agentName === undefined ? undefined : core.agentCatalog.find(agentName);
    // COR-2387: a file agent is scanned with the definition its run recorded, never the catalog's
    // current one, which an operator may have edited while the run was parked. A snapshot that
    // cannot be rebuilt leaves the result to Bureau's own guardrails alone.
    const recordedReference =
      agentName === undefined ? undefined : await core.fileAgents?.snapshots.reference(runId);
    if (
      core.fileAgents !== undefined &&
      agentName !== undefined &&
      recordedReference !== undefined &&
      recordedReference.id === agentName
    ) {
      try {
        const rebuilt = await core.fileAgents.agentForRecordedRun(
          agentName,
          recordedReference.hash,
          recordedReference.definitionRevision,
          runId,
        );
        agent = rebuilt.agent;
      } catch {
        agent = undefined;
      }
    }
    if (agent !== undefined && hasDefinitionResolver(agent)) {
      try {
        const resolved = await agent[OPERATIVE_RESOLVE_RUN_OPTIONS]('', {
          runId,
          sessionTaint,
          ...(agentName === undefined ? {} : { agentName }),
          ...catalogRunGuardrailsContext(agent),
        });
        return runtime.composeRunHooks({
          bureau: runtime.createBureauInvariantHooks(undefined, {
            agentResolvesGuardrails: resolvesOwnGuardrails(agent),
            sessionTaint,
          }),
          agent: resolved.hooks,
        });
      } catch {
        // Falls through to Bureau's own guardrails, which still scan the result.
      }
    }
    return runtime.composeRunHooks({
      bureau: runtime.createBureauInvariantHooks(undefined, { sessionTaint }),
      agent: undefined,
    });
  }

  /**
   * COR-2299 — an approved call runs outside the run's step, so its result reaches the session
   * without the run loop's `validateToolResult` scan. Scanned here with the run's own hook plan (a
   * run this process does not hold has one built from its agent, seeded from the session's
   * persisted taint), a hit writes the blocked result in its place, as the loop does, and taints
   * the session; the taint is stored before this returns. A scan that fails does the same
   * (COR-2300).
   */
  async function scanApprovedToolResult(
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    executed: ToolExecutionResult,
  ): Promise<ToolExecutionResult> {
    let conversation = new Conversation(undefined, { runtime: runtimeServices });
    let metadata: Record<string, JSONValue> | undefined;
    try {
      const stored = await runtime.sessionStore?.load(review.sessionId);
      if (stored !== undefined) {
        conversation = new Conversation(stored.conversationHistory, { runtime: runtimeServices });
        metadata = stored.metadata;
      }
    } catch {
      // The conversation only gives a detector its length; an unreadable session is scanned empty,
      // and starts untainted in memory (a taint it raises is still stored).
    }
    const seam = runtime.sessionTaintSeam(review.sessionId, review.runId, metadata);
    const hooks =
      runHookPlans.get(review.runId) ??
      (await catalogRunHookPlan(review.runId, seam, review.agentName));
    const firings: GuardrailFiring[] = [];
    const scanned = await scanToolResult(executed, {
      hooks,
      conversation,
      step: 0,
      reportGuardrail: (firing) => firings.push(firing),
    });
    if (scanned.blocked) {
      // A result a guardrail refused taints the session. The tracker that refused it stores the
      // taint when it holds the seam, which every agent tier does; a tier built without one (a
      // hand-written agent under Bureau's guardrails), a tripwire below the taint threshold, and a
      // scan that failed before a tracker could are stored here. A session that already holds a
      // taint keeps it (the write is compare-and-set), so this never publishes twice.
      const firing = firings[0];
      await seam.onTainted({
        reason: 'A guardrail refused the result of an approved call',
        detector: scanned.tripwire?.guardrailName ?? firing?.guardrailName ?? 'tool-result-scan',
        category:
          scanned.tripwire?.category ??
          firing?.category ??
          (scanned.failed === true ? 'detector-failure' : 'blocked-tool-result'),
        confidence: scanned.tripwire?.confidence ?? firing?.confidence ?? 1,
        step: 0,
        provenance: 'tool-result',
      });
      diagnose({
        level: 'warn',
        scope: 'guardrails',
        message: `[bureau] A guardrail blocked the result of the approved call "${review.approval.callId}" of run "${review.runId}"${scanned.tripwire === undefined ? '' : ' (tripwire)'}; the session holds the blocked result.`,
      });
    }
    return scanned.result;
  }

  /** {@link scanApprovedToolResult} for a result of unknown shape: only a tool's own is scanned. */
  async function scannedApprovedOutcome(
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    result: unknown,
  ): Promise<ToolExecutionResult> {
    return await scanApprovedToolResult(review, result as ToolExecutionResult);
  }

  return { scanApprovedToolResult, scannedApprovedOutcome };
}
