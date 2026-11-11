import { HOOK_TIER_PRIORITY_BANDS, HookRegistry } from '@lostgradient/lifecycle';
import type {
  OperativeHookMap,
  GuardrailHooks,
  OnStepHook,
  JSONValue,
} from '@lostgradient/operative';
import { createIdentityHook } from '@lostgradient/operative';
import type { ToolRequestContext } from 'armorer';
import { isPlainAuthorityRecord } from './session-authority';
import { ownEntry } from './own-entry';
import type { RuntimeCompositionOptions } from './runtime-composition-types';

/**
 * `createRuntimeComposition` builds bureau-level generate/toolbox/
 * persistence/durability composition — entirely orthogonal to the typed
 * `agents` catalog (AB-22), which `createBureau` wires separately. Omitting
 * `agents` here means every existing caller (including the 100+ direct
 * `createRuntimeComposition({...})` calls in this package's own test suite)
 * keeps working unchanged; it is not part of this function's contract.
 */
/**
 * Priority pinning a Bureau registration behind every other tier's entries on
 * the same hook point (COR-1265, criteria 9 and 10), before the `bureau` band
 * is added.
 *
 * Two dispatch shapes let a later handler decide the outcome: `runLast`
 * returns the last defined result, and the waterfall feeds each handler the
 * previous one's return value. On both, "runs last" means "wins", so a Bureau
 * registration that narrows — today `bureau:guardrails-validate-response` — has
 * to sort behind whatever an agent or a direct caller registered. The trailing
 * `onStep` hooks take the same value for the ordering reason rather than the
 * authority one: they persist the session once the step's mutations settle, and
 * an agent-tier `onStep` handler is one of those mutations.
 *
 * The tier band works against Bureau here. `mergeHookRegistries` adds each
 * tier's fixed band (`HOOK_TIER_PRIORITY_BANDS`, COR-2127), and Bureau's is the
 * LARGEST — `+3000`, above the plugin, agent and direct tiers. The constant
 * sits that band above `Number.MIN_SAFE_INTEGER`, so a merged Bureau entry
 * stays inside the safe-integer range and still lands below anything
 * registered at a priority a caller would plausibly write, whichever tiers a
 * run has.
 *
 * The residual, stated rather than implied: a lower tier whose entry, band
 * included, sits at or below this one's merged priority sorts after it
 * anyway. No finite constant closes that, because a priority is a plain number
 * with no floor, and `-Infinity` closes it only until a second entry carries it
 * — the registry's `b.priority - a.priority` comparator would then return
 * `NaN`. A tier deliberately reaching for the bottom of the number line is not
 * the threat this is defending against; an ordinary registration that happens
 * to outrank Bureau is.
 */
export const BUREAU_PINNED_LAST_PRIORITY =
  Number.MIN_SAFE_INTEGER + HOOK_TIER_PRIORITY_BANDS.bureau;
/**
 * The ownership tier every registration Bureau makes belongs to (COR-1265) —
 * set once on a registry, stamped by `on()` onto each entry so it survives
 * `mergeHookRegistries`.
 */
export const BUREAU_HOOK_TIER = 'bureau';
/**
 * Registers the identity invariant. Shared by the per-run composition and by
 * {@link RuntimeComposition.createBureauInvariantHooks}, which is the whole
 * reason it is a function: the two register at different points in their own
 * registries and must not drift into two different registrations.
 */
export function registerIdentityInvariant(
  registry: HookRegistry<OperativeHookMap>,
  identity: NonNullable<RuntimeCompositionOptions['identity']>,
): void {
  registry.on('prepareStep', createIdentityHook(identity), {
    id: 'bureau:identity',
    // Appends a system message to the step's conversation and touches nothing
    // outside it; a replayed step rebuilds that conversation from persisted
    // history, so re-running this reproduces state rather than repeating an
    // external effect.
    replay: 'safe',
  });
}
/**
 * Registers the guardrail invariants: the input scan, the tool-result scan (COR-2103), the output
 * check, and the tool-call validators (COR-2104), in the order the legacy arrays ran the first and
 * last.
 *
 * The caller decides WHEN — the per-run composition registers `prepareStep`
 * last of all its `prepareStep` hooks on purpose, so the input guardrail scans a
 * step context every earlier hook has already contributed to.
 */
export function registerGuardrailInvariants(
  registry: HookRegistry<OperativeHookMap>,
  guardrails: GuardrailHooks,
): void {
  registry.on('prepareStep', guardrails.prepareStep, {
    id: 'bureau:guardrails-prepare-step',
    // Scans and may taint the session. The taint is stored by a compare-and-swap that keeps the first
    // one, so a replayed step stores nothing twice (COR-2105).
    replay: 'safe',
  });
  registry.on('validateResponse', guardrails.validateResponse, {
    id: 'bureau:guardrails-validate-response',
    // COR-1265 criterion 10. `validateResponse` is dispatched as a waterfall,
    // so the LAST handler to answer hands its response to the run — an agent-
    // or direct-tier handler running after this one would decide what the
    // guardrail's narrowing was worth. Pinned last so it does not.
    priority: BUREAU_PINNED_LAST_PRIORITY,
    replay: 'safe',
  });
  // COR-2103 — the input detectors over each tool result. `validateToolResult` is a waterfall too,
  // so it is pinned last for the same reason as `validateResponse`.
  registry.on('validateToolResult', guardrails.validateToolResult, {
    id: 'bureau:guardrails-validate-tool-result',
    priority: BUREAU_PINNED_LAST_PRIORITY,
    replay: 'safe',
  });
  // COR-2104 — the tool-call validators. `beforeToolExecution` waterfalls the call list, so they
  // are pinned last too: they judge the calls every other tier's hook settled on.
  registry.on('beforeToolExecution', guardrails.beforeToolExecution, {
    id: 'bureau:guardrails-before-tool-execution',
    priority: BUREAU_PINNED_LAST_PRIORITY,
    replay: 'safe',
  });
}
/**
 * Priority placing a hook after every hook bureau's own composition registered.
 *
 * The same value as {@link BUREAU_PINNED_LAST_PRIORITY}, and deliberately not a
 * separate band: COR-1265's criterion 9 makes the two trailing hooks outrank
 * every tier's `onStep` handlers, not merely Bureau's own, and a value chosen
 * relative to Bureau's default `0` could not do that once a second tier exists.
 */
const TRAILING_HOOK_PRIORITY = BUREAU_PINNED_LAST_PRIORITY;
/**
 * Registers a per-call `onStep` hook that must run AFTER the run runtime's own
 * — the session write-back on a scheduled fire, the pending-approval persist on
 * an interactive run. Both were array spreads (`[...runRuntime.onStep, extra]`)
 * whose ordering came from their position in the literal; the priority states
 * it instead, so it survives the hook moving.
 *
 * This mutates the run's registry and returns it, rather than merging into a
 * fresh one, because the registry is created per run inside `createRunRuntime`
 * and the caller here owns that run outright.
 *
 * COR-1265: every caller now merges the result before handing it to a run, so
 * the completed Bureau tier is what `composeRunHooks` takes as its `bureau`
 * tier. That ordering is the point — registering here AFTER the merge would
 * put the trailing hook in the merged registry at its raw priority while every
 * other Bureau entry had already been given the `bureau` band, which is
 * precisely the renumbering this function used to avoid by refusing to merge at
 * all.
 */
export function registerTrailingOnStep(
  hooks: HookRegistry<OperativeHookMap>,
  id: string,
  handler: OnStepHook,
): HookRegistry<OperativeHookMap> {
  hooks.on('onStep', handler, {
    id,
    priority: TRAILING_HOOK_PRIORITY,
    // Writes a session record.
    replay: 'effectful',
  });
  return hooks;
}
/**
 * COR-1596 — the field of a persisted request authority that says it is a schedule fire's.
 */
export const SCHEDULED_FIRE_AUTHORITY_MARKER = 'scheduledFire';
/**
 * COR-1596 — whether the authority a session recorded for `runId` is a schedule fire's. A fire
 * runs on the Bureau-wide runtime and its agent name is a label, not a catalog entry, so what
 * resumes its approval after a restart must not look the name up in the catalog the way a session
 * run's does.
 */
export function isScheduledFireAuthority(
  metadata: Record<string, JSONValue>,
  runId: string,
): boolean {
  const authorities = metadata['lastRequestAuthorities'];
  if (!isPlainAuthorityRecord(authorities)) return false;
  const authority = ownEntry(authorities, runId);
  return isPlainAuthorityRecord(authority) && authority[SCHEDULED_FIRE_AUTHORITY_MARKER] === true;
}
/**
 * COR-1596 — what a schedule fire's session records for a tool call its step left awaiting
 * approval: the pending approval under its review id, its supersession round (0, or the round
 * already recorded), and the request authority the fire ran under. These are the keys a session
 * run's approvals are recorded under, so the boot restore of a terminal run's approvals finds a
 * fire's too. Idempotent by key: a replayed step writes the same entries.
 *
 * `committed`, given for a fire that is replaying after a crash, names the review ids of the
 * approvals the run's checkpoint holds. A fire writes its session as each step completes and
 * commits the step after, so a crash between the two leaves an approval in the session that the
 * run never committed; the replay may not make that call again. Every approval of this run that
 * is neither committed nor this step's is dropped from the write, and the authority with the last
 * of them.
 */
export function scheduledFireApprovalMetadata(
  metadata: Record<string, JSONValue>,
  runId: string,
  results: readonly { readonly outcome: string; readonly pendingApproval?: unknown }[],
  requestContext: ToolRequestContext,
  committed?: ReadonlySet<string>,
): Record<string, JSONValue> {
  const prefix = `approval:${runId}:`;
  // A review the session records as decided is not recorded as pending again: a replay that
  // makes the same call under the same id would list it for ever, with nothing to decide.
  const decided = new Set(
    Array.isArray(metadata['resolvedReviewIds']) ? metadata['resolvedReviewIds'] : [],
  );
  const approvals: Array<[string, JSONValue]> = [];
  for (const result of results) {
    if (result.outcome !== 'action_required' || result.pendingApproval === undefined) continue;
    const approval = JSON.parse(JSON.stringify(result.pendingApproval)) as JSONValue;
    const callId = isPlainAuthorityRecord(approval) ? approval['callId'] : undefined;
    if (typeof callId !== 'string' || decided.has(`${prefix}${callId}`)) continue;
    approvals.push([`${prefix}${callId}`, approval]);
  }
  const recordOf = (value: JSONValue | undefined): Record<string, JSONValue> =>
    isPlainAuthorityRecord(value) ? value : {};
  const stepIds = new Set(approvals.map(([id]) => id));
  const existingOverrides = recordOf(metadata['pendingApprovalOverrides']);
  const abandoned = new Set(
    committed === undefined
      ? []
      : Object.keys(existingOverrides).filter(
          (id) => id.startsWith(prefix) && !committed.has(id) && !stepIds.has(id),
        ),
  );
  if (approvals.length === 0 && abandoned.size === 0) return {};
  const without = (record: Record<string, JSONValue>): Record<string, JSONValue> =>
    Object.fromEntries(Object.entries(record).filter(([id]) => !abandoned.has(id)));
  const overrides = { ...without(existingOverrides), ...Object.fromEntries(approvals) };
  const rounds = recordOf(metadata['pendingApprovalRounds']);
  const authorities = recordOf(metadata['lastRequestAuthorities']);
  const authority = JSON.parse(
    JSON.stringify({
      ...requestContext.authority,
      ...(requestContext.audience === undefined ? {} : { audience: requestContext.audience }),
      ...(requestContext.agentId === undefined ? {} : { agentId: requestContext.agentId }),
      [SCHEDULED_FIRE_AUTHORITY_MARKER]: true,
    }),
  ) as JSONValue;
  const { [runId]: _ended, ...otherAuthorities } = authorities;
  const holdsApproval = Object.keys(overrides).some((id) => id.startsWith(prefix));
  return {
    pendingApprovalOverrides: overrides,
    pendingApprovalRounds: {
      ...without(rounds),
      ...Object.fromEntries(approvals.map(([id]) => [id, ownEntry(rounds, id) ?? 0])),
    },
    lastRequestAuthorities: holdsApproval
      ? { ...authorities, [runId]: authority }
      : otherAuthorities,
  };
}
