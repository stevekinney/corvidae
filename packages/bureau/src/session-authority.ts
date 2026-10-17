import type { JSONValue } from '@lostgradient/operative';

/**
 * Resolves what a session's metadata records about its most recent run's
 * authority, per AB-42's coordinator ruling (2026-09-02): reads
 * `metadata['lastRequestAuthorities'][lastRunId]?.principalId`, falling back
 * to the legacy `metadata['lastRequestAuthority'].principalId` exactly as
 * {@link recoveredRequestContextFromMetadata} already does.
 *
 * `{ recorded: false }` means the session has recorded no authority at
 * all — an "open" session, per the ruling. `{ recorded: true, principalId }`
 * means an authority WAS recorded; `principalId` is `undefined` only when
 * that recorded authority is itself malformed (missing or non-string
 * `principalId`), which must fail closed (deny every principal), never be
 * read as "open" — a corrupted or partially-written persistence record must
 * not silently grant access. This is why a per-run entry present-but-malformed
 * does NOT fall back to the legacy field the way a genuinely absent per-run
 * entry does: once a per-run entry exists, it is authoritative for that run,
 * so silently falling through past a corrupted record would suppress exactly
 * the failure this distinction exists to catch — conflating "absent" with
 * "malformed" is the class of bug this whole function guards against.
 *
 * The same reasoning extends to a non-empty-but-uncorrelated
 * `lastRequestAuthorities` map (see below): it is checked BEFORE the legacy
 * fallback, not after, because that exact shape is what two concurrent runs
 * on one session produce, and the legacy field may belong to the OTHER,
 * unrelated run — see the concurrent-run correlation note below.
 *
 * A completed/aborted/errored run's `lastRequestAuthorities[lastRunId]` entry
 * is pruned on terminal transition (see the cleanup near `remainingAuthorities`
 * below), while the legacy singular `lastRequestAuthority` is retained — so a
 * per-run lookup that is GENUINELY ABSENT (no map, no `lastRunId`, or the key
 * missing from the map) falls back to the legacy field.
 */
export function isPlainAuthorityRecord(
  value: JSONValue | undefined,
): value is Record<string, JSONValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lookupSessionAuthority(
  metadata: Record<string, JSONValue>,
  // AB-67/AB-199 review finding (PR #430 — Codex P2, "Authorize against the
  // targeted live run"): defaults to `metadata['lastRunId']` — the
  // single-run behavior an untargeted caller (`recordedSessionAuthorityPrincipalId`,
  // the session-owner reads in `eventHistory`) keeps — but a caller that
  // already knows which run a command actually targets (both session verbs,
  // through `resolveSessionPreAdmission`, once they resolve an explicit
  // `runId` or the session's sole live run) passes it explicitly.
  // Without this, a run B that completes first prunes only its OWN
  // `lastRequestAuthorities[B]` entry (see the terminal-transition cleanup
  // below) while leaving `lastRunId: B` and A's now-uncorrelated entry
  // behind; the uncorrelated-map branch below then fails EVERY principal
  // closed before a command explicitly naming still-live run A ever gets a
  // chance to authorize against A's own (perfectly valid) entry.
  targetRunId?: string,
):
  | { readonly recorded: false }
  | { readonly recorded: true; readonly principalId: string | undefined } {
  const lastRunId = targetRunId ?? metadata['lastRunId'];
  const authorities = metadata['lastRequestAuthorities'];
  // A PRESENT-but-malformed `lastRequestAuthorities` value (not absent — a
  // string or array where a map belongs) is itself evidence something was
  // recorded and corrupted. It must fail closed regardless of `lastRunId` or
  // a legacy fallback, never be read as "nothing recorded" (open) — the same
  // fail-closed principle as a malformed per-run/legacy entry below.
  if (authorities !== undefined && !isPlainAuthorityRecord(authorities)) {
    return { recorded: true, principalId: undefined };
  }
  const perRunEntry = authorityForRun(authorities, lastRunId);
  const legacy = metadata['lastRequestAuthority'];
  let candidate: JSONValue | undefined;
  if (perRunEntry !== undefined) {
    candidate = perRunEntry;
  } else if (authorities !== undefined && Object.keys(authorities).length > 0) {
    // A valid, non-empty `lastRequestAuthorities` map exists but doesn't
    // correlate to this run (`lastRunId` missing/corrupt, or the map's
    // entries are keyed to other runs). Checked BEFORE the legacy fallback,
    // not after: this exact shape is what two concurrent runs on one session
    // produce — run B's dispatch overwrites the singular legacy field with
    // B's authority while A is still running, so trusting legacy here would
    // authorize B's principal against A's (still-uncorrelated) run. A
    // non-empty-but-uncorrelated map is recorded-but-uncorrelated evidence,
    // not "nothing recorded" — fail closed rather than consult a legacy
    // field that may belong to an unrelated concurrent run.
    return { recorded: true, principalId: undefined };
  } else if (legacy !== undefined) {
    candidate = legacy;
  } else {
    return { recorded: false };
  }
  if (!isPlainAuthorityRecord(candidate)) {
    return { recorded: true, principalId: undefined };
  }
  const principalId = candidate['principalId'];
  return { recorded: true, principalId: typeof principalId === 'string' ? principalId : undefined };
}

function authorityForRun(
  authorities: Record<string, JSONValue> | undefined,
  runId: JSONValue | undefined,
): JSONValue | undefined {
  if (typeof runId !== 'string' || !runId || authorities === undefined) return undefined;
  return authorities[runId];
}

/**
 * The `principalId` recorded for a session's most recent run, per
 * {@link lookupSessionAuthority}'s rule. Returns `undefined` both when the
 * session has recorded no authority at all AND when a recorded authority is
 * malformed — this function alone cannot distinguish the two, so it is
 * informational only. {@link isSessionAuthorityAuthorized} is the
 * security-relevant surface: it fails closed (denies) for malformed
 * authority, never treating it as open the way "genuinely no authority
 * recorded" is treated.
 *
 * It reads the pre-existing metadata keys `create-bureau.ts` already writes
 * on every run dispatch, with no target run, so it always resolves against
 * `lastRunId`. The session verbs (`submitSessionInput`,
 * `submitSteeringCommand`) do not use it: they authorize against the run a
 * request targets, through {@link resolveSessionPreAdmission}.
 */
export function recordedSessionAuthorityPrincipalId(
  metadata: Record<string, JSONValue>,
): string | undefined {
  const lookup = lookupSessionAuthority(metadata);
  return lookup.recorded ? lookup.principalId : undefined;
}

/**
 * Whether `principal` is authorized to act on a session recording the given
 * metadata, per {@link lookupSessionAuthority}'s rule. A session with no
 * recorded authority at all is treated as open — every principal is
 * authorized — matching what every existing session verb enforces today
 * (nothing stronger), per AB-42's coordinator ruling (2026-09-02). A session
 * with a RECORDED-BUT-MALFORMED authority fails closed: no principal is
 * authorized, since a corrupted record cannot be verified to match anyone.
 */
export function isSessionAuthorityAuthorized(
  metadata: Record<string, JSONValue>,
  principal: string,
  // See {@link lookupSessionAuthority}'s doc comment on its own `targetRunId`
  // parameter — forwarded verbatim.
  targetRunId?: string,
): boolean {
  const lookup = lookupSessionAuthority(metadata, targetRunId);
  if (!lookup.recorded) return true;
  return lookup.principalId === principal;
}

/**
 * The owning principal persisted for `runId` in a session's
 * `lastRunOwningPrincipals` map (AB-359), or `undefined` when nothing was
 * recorded, the map itself is malformed, or the recorded entry for this
 * `runId` isn't a string. Every one of those cases decodes to `undefined`
 * on purpose: an older record written before this field existed has no
 * `lastRunOwningPrincipals` key at all, and must decode with ownership
 * absent rather than throw or be treated as corrupt — exactly the same
 * schema-version-tolerant contract {@link UnsupportedDurableEventSchemaVersionError}
 * enforces for a durable event record's own payload wrapper. `undefined`
 * here is consumed by `reattachRecoveredRun`, which then leaves
 * `runAttribution` for this run unset — reproducing AB-313's existing
 * fail-closed behavior for "no principal recorded" after a restart, the
 * same as it already does live.
 */
export function resolvePersistedRunOwningPrincipal(
  metadata: Record<string, JSONValue>,
  runId: string,
): string | undefined {
  const owners = metadata['lastRunOwningPrincipals'];
  if (!isPlainAuthorityRecord(owners)) return undefined;
  const principal = owners[runId];
  return typeof principal === 'string' ? principal : undefined;
}

/**
 * Whether a session has no run in progress: its most recently persisted run
 * (`metadata['lastRunStatus']`, the field {@link requireSessionRunId} and
 * {@link hasRecoverableTransportAuthority} also read) is not `'running'`, AND
 * `liveRunIds`, the session's runs that the caller's live-run registry
 * still holds as running, is empty. `lastRunStatus` is last-write-wins across
 * concurrent runs, so the run that went terminal last can overwrite it while
 * an older run on the same session is still running; the live-run set is
 * what keeps that session from reading as terminal (COR-301). With the
 * default empty set this reads `lastRunStatus` alone.
 */
export function isSessionRunTerminal(
  metadata: Record<string, JSONValue>,
  liveRunIds: readonly string[] = [],
): boolean {
  return metadata['lastRunStatus'] !== 'running' && liveRunIds.length === 0;
}

/**
 * The pre-admission verdict both session verbs (`submitSessionInput`,
 * `submitSteeringCommand`) share, in AB-42's fixed order: authorization
 * first (`'not-found'`), then session lifecycle (`'session-terminal'`), else
 * `'proceed'` to the verb's own capability and admission checks.
 *
 * `liveRunIds` is the session's still-running runs as the caller's live-run
 * registry reports them (COR-301; the PR #430 review findings "Consult live
 * runs before declaring the session terminal" and "Authorize against the
 * targeted live run" that first fixed this for steering). Authorization
 * targets `explicitRunId` when the request names a run, else the session's
 * sole live run, else falls back to {@link lookupSessionAuthority}'s
 * `lastRunId` default, the only choice left when several runs are live and
 * none is named. Targeting the run matters because a concurrent run's
 * terminal write prunes only its own `lastRequestAuthorities` entry and
 * leaves `lastRunId` pointing at itself, which would otherwise fail every
 * principal closed (or, once the map is empty, authorize whichever principal
 * dispatched last). The session is terminal only when its last persisted run
 * is not running and no run is live ({@link isSessionRunTerminal}).
 */
export function resolveSessionPreAdmission(
  metadata: Record<string, JSONValue>,
  principal: string,
  liveRunIds: readonly string[],
  explicitRunId?: string,
): 'not-found' | 'session-terminal' | 'proceed' {
  const targetRunId = explicitRunId ?? (liveRunIds.length === 1 ? liveRunIds[0] : undefined);
  if (!isSessionAuthorityAuthorized(metadata, principal, targetRunId)) return 'not-found';
  if (isSessionRunTerminal(metadata, liveRunIds)) return 'session-terminal';
  return 'proceed';
}
