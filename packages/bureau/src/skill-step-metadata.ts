import type { JSONValue, StepRecord, SessionStore, OnStepHook } from '@lostgradient/operative';
import type { SkillActivationRecord } from './skills';
import { createToolbox, type ToolCallInput } from 'armorer';
import type { RecoveredSkillPolicy, BureauToolbox } from './runtime-composition-types';

export const activeSkillsStepMetadataKey = '__bureauActiveSkills';
const activeSkillsStepMetadataVersion = 2;
export function activeSkillsStepMetadata(records: readonly SkillActivationRecord[]): JSONValue {
  return {
    version: activeSkillsStepMetadataVersion,
    entries: records as unknown as JSONValue,
  };
}
export function activeSkillsFromStepMetadata(
  metadata: StepRecord['metadata'],
): SkillActivationRecord[] | undefined {
  const raw = metadata?.[activeSkillsStepMetadataKey];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const snapshot = raw as Record<string, unknown>;
  if (snapshot['version'] !== activeSkillsStepMetadataVersion) return undefined;
  const entries = snapshot['entries'];
  return isSkillActivationRecordArray(entries) ? entries : undefined;
}
/**
 * Validates a value read back out of session or step metadata as activation records.
 *
 * Every digest field is required, not optional. A record missing one would recover a skill by name
 * with nothing to check the content against, which is the failure the records exist to prevent —
 * so a malformed snapshot recovers nothing rather than recovering unverifiably.
 */
export function isSkillActivationRecordArray(value: unknown): value is SkillActivationRecord[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return false;
    const candidate = item as Record<string, unknown>;
    for (const field of [
      'name',
      'sourceId',
      'sourceKind',
      'trust',
      'artifactDigest',
      'instructionsDigest',
      'activatedAt',
    ]) {
      if (typeof candidate[field] !== 'string') return false;
    }
    if (typeof candidate['catalogRevision'] !== 'number') return false;
    if (!Array.isArray(candidate['requestedTools'])) return false;
    if (candidate['requestedTools'].some((tool) => typeof tool !== 'string')) return false;
  }
  return true;
}
/**
 * The session-metadata keys a step boundary writes.
 *
 * The same keys {@link createSkillRecordSnapshotHook} writes, deliberately: one snapshot
 * mechanism, one set of keys, one thing for recovery to read. Two parallel snapshots is how a
 * recovered run ends up restoring whichever of them the reader happened to know about.
 */
export function activeSkillSessionMetadataForStep(
  records: readonly SkillActivationRecord[],
  step: number,
  runId?: string,
): Record<string, JSONValue> {
  return {
    activeSkillRecords: records as unknown as JSONValue,
    ...(runId !== undefined
      ? {
          activeSkillRecordsRunId: runId,
          activeSkillRecordsStep: step,
        }
      : {}),
  };
}
/** A snapshot field named in a reason: its string, or what the field holds instead. */
export function describe(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : value === null ? 'null' : 'nothing';
}
const recoveredSkillPolicies = new WeakMap<object, RecoveredSkillPolicy>();
/** Records what recovery built `toolbox` with. */
export function recordRecoveredSkillPolicy(toolbox: object, policy: RecoveredSkillPolicy): void {
  recoveredSkillPolicies.set(toolbox, policy);
}
/** What recovery built `toolbox` with, or `undefined` for a toolbox it did not build. */
export function recoveredSkillPolicyOf(toolbox: object): RecoveredSkillPolicy | undefined {
  return recoveredSkillPolicies.get(toolbox);
}
export function recordedAgentStep(value: unknown): StepRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate['conversationSnapshot'] !== 'object' ||
    candidate['conversationSnapshot'] === null
  ) {
    return undefined;
  }
  if (typeof candidate['nextAccumulators'] !== 'object' || candidate['nextAccumulators'] === null) {
    return undefined;
  }
  const record = candidate['record'];
  if (typeof record !== 'object' || record === null) return undefined;
  const stepRecord = record as Record<string, unknown>;
  const step = stepRecord['step'];
  if (!Number.isInteger(step) || (step as number) < 0) return undefined;
  if (typeof stepRecord['content'] !== 'string') return undefined;
  // COR-713: only a current-version step record counts; an older one carries no parts.
  if (stepRecord['schemaVersion'] !== 2 || !Array.isArray(stepRecord['parts'])) return undefined;
  if (!Array.isArray(stepRecord['toolCalls'])) return undefined;
  if (!Array.isArray(stepRecord['results'])) return undefined;
  if (typeof stepRecord['final'] !== 'boolean') return undefined;
  if (
    stepRecord['metadata'] !== undefined &&
    (typeof stepRecord['metadata'] !== 'object' ||
      stepRecord['metadata'] === null ||
      Array.isArray(stepRecord['metadata']))
  ) {
    return undefined;
  }
  return record as StepRecord;
}
/**
 * Snapshot the active skill set to session metadata after each completed step.
 *
 * EFFECTFUL hook (seam #11): on a durable recovery the crashed in-flight step
 * re-runs from its boundary, so this hook can fire AGAIN for the same step. The
 * write is IDEMPOTENT — a re-fire for step N overwrites `activeSkillRecords` with the
 * same value (completed steps do not re-run their tool executions, so the active-skill
 * set is unchanged on replay). This is a state snapshot, NOT an append — the last
 * writer wins (matching the single-source-of-truth model for `activeSkillRecords`).
 *
 * Replay classification: `effectful` (writes to external storage) but SAFE across
 * recovery re-fires because the payload is deterministic for a given step boundary
 * (completed steps replay identically, producing the same active-skill set).
 */
/**
 * Snapshots the catalog revision and every activation record after each step.
 *
 * The provider-backed snapshot carries a name and a tool policy. That is enough to re-activate
 * something with the same name and nothing at all to prove it is the same skill — COR-752 named
 * exactly this gap ("neither carries source, trust decision, digest, or admitted instructions").
 * These records carry the source, the trust decision, the artifact digest and the instructions
 * digest, which is what lets recovery refuse a skill whose content drifted rather than silently
 * resurrecting different text under a reviewed name.
 */
export function createSkillRecordSnapshotHook(
  client: { activationRecords(): readonly SkillActivationRecord[] },
  catalog: { revision: number; digest: string },
  sessionId: string,
  store: SessionStore,
  runId?: string,
): OnStepHook {
  return async (context) => {
    try {
      await store.updateMetadata(sessionId, {
        activeSkillRecords: client.activationRecords() as unknown as JSONValue,
        skillCatalogRevision: catalog.revision,
        skillCatalogDigest: catalog.digest,
        ...(runId === undefined
          ? {}
          : { activeSkillRecordsRunId: runId, activeSkillRecordsStep: context.step }),
      });
    } catch {
      // Non-fatal, same as the entry-based hook: a failed snapshot must not abort the step. The
      // cost is that recovery starts from an empty active set, which is the safe direction.
    }
  };
}
export function createUnavailableToolbox(): BureauToolbox {
  const emptyToolbox = createToolbox([], { context: {} });
  const execute = ((
    toolCalls: ToolCallInput | ToolCallInput[],
    executionOptions?: Parameters<BureauToolbox['execute']>[1],
  ) => {
    const normalizedToolCalls = Array.isArray(toolCalls) ? toolCalls : [toolCalls];
    if (normalizedToolCalls.length > 0) {
      throw new Error('No toolbox configured but tool calls were received');
    }

    return emptyToolbox.execute([], executionOptions);
  }) as unknown as BureauToolbox['execute'];

  return {
    ...emptyToolbox,
    execute,
  };
}
