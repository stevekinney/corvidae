import type { PermissionMode } from '@lostgradient/operative';

/** How far up a run's parents the walk goes before it gives up; no delegation chain is this deep. */
const MAXIMUM_LINEAGE_DEPTH = 64;

/** What {@link permissionModeOfLineage} reads. */
export interface ChatPermissionLineage {
  /**
   * The run that started `runId` as its child, or `undefined` for a run that is not a child (a
   * chat's own run, or one that belongs to no chat). A read that fails rejects.
   */
  readonly parentOf: (runId: string) => Promise<string | undefined>;
  /**
   * The mode of the chat `runId` itself belongs to, or `undefined` for a run no chat holds. It is
   * asked only of the root of the walk.
   */
  readonly modeOf: (runId: string) => Promise<PermissionMode | undefined>;
}

/**
 * COR-1955 — the permission mode that holds `runId`: the mode of the chat at the root of the
 * delegation chain it belongs to. A child, a grandchild, and a child detached from a parent that
 * has ended all take the mode their root chat holds at the time of the call, so a steer reaches a
 * child that was already running. `undefined` for a chain whose root belongs to no chat, which has
 * no mode to be held to.
 *
 * It rejects, and the approval hook then counts the call as `read-only`, when a parent cannot be
 * read or the chain loops or is implausibly deep: a lineage that cannot be walked is held to the
 * strictest answer rather than a guessed one.
 */
export async function permissionModeOfLineage(
  runId: string,
  lineage: ChatPermissionLineage,
): Promise<PermissionMode | undefined> {
  const visited = new Set<string>();
  let current = runId;
  for (;;) {
    if (visited.has(current) || visited.size >= MAXIMUM_LINEAGE_DEPTH) {
      throw new Error(`The parents of run "${runId}" do not end at a root.`);
    }
    visited.add(current);
    const parent = await lineage.parentOf(current);
    if (parent === undefined) return await lineage.modeOf(current);
    current = parent;
  }
}
