/**
 * Which agent files name the tools of a saved tool source (COR-1931), so the owner sees what a
 * removal will break before it happens and the removal reports it afterwards.
 *
 * An agent file names a tool twice: in `tools`, and in `toolApproval`, which can hold an entry the
 * `tools` list does not (such a file is already invalid, `unknown-approval-tool`, but it still
 * names the tool and still needs the owner's attention when the tool goes). Both are read, from the
 * parsed definition the Bureau keeps even for an invalid file. A file that does not parse names
 * nothing the catalog can read, so it is left out. Nothing here writes: an agent file is never
 * rewritten for the owner.
 *
 * @module tool-source-agents
 */

import type { AgentFileDetail, AgentListing } from '@lostgradient/bureau';

/** The tool names one agent file mentions. */
export type AgentToolUse = {
  /** The agent's identifier: the file name without `.md`. */
  readonly id: string;
  /** The display name. */
  readonly name: string;
  /** The names in the file's `tools`. */
  readonly tools: readonly string[];
  /** The names in the file's `toolApproval`. */
  readonly toolApproval: readonly string[];
};

/** An agent file that names at least one tool of a source. */
export type AffectedAgent = {
  /** The agent's identifier: the file name without `.md`. */
  readonly id: string;
  /** The display name. */
  readonly name: string;
  /** The source's tools the file lists in `tools`, sorted. */
  readonly tools: readonly string[];
  /** The source's tools the file names in `toolApproval`, sorted; may include a tool `tools` does not list. */
  readonly toolApproval: readonly string[];
};

/** What the Bureau's agent catalog offers that this reads. */
export type AgentFileReader = {
  /** Every agent the catalog lists, ready or invalid. */
  list(): readonly AgentListing[];
  /** One agent as it is on disk now, with its parsed definition. */
  detail(id: string): Promise<AgentFileDetail | undefined>;
};

/** Read, for every file agent, the tools its file names. A code agent has no file and is skipped. */
export function agentToolUseOf(catalog: AgentFileReader): () => Promise<readonly AgentToolUse[]> {
  return async () => {
    const found: AgentToolUse[] = [];
    for (const listing of catalog.list()) {
      if (listing.source !== 'file') continue;
      const detail = await catalog.detail(listing.id);
      const definition = detail?.definition;
      if (definition === undefined || definition === null) continue;
      found.push({
        id: listing.id,
        name: listing.name,
        tools: definition.tools,
        toolApproval: Object.keys(definition.toolApproval ?? {}),
      });
    }
    return found;
  };
}

/** The files in `use` that name any of `toolNames`, with the names they use, in the order `use` lists them. */
export function affectedAgents(
  use: readonly AgentToolUse[],
  toolNames: ReadonlySet<string>,
): AffectedAgent[] {
  const affected: AffectedAgent[] = [];
  for (const file of use) {
    const tools = file.tools.filter((name) => toolNames.has(name)).toSorted();
    const toolApproval = file.toolApproval.filter((name) => toolNames.has(name)).toSorted();
    if (tools.length === 0 && toolApproval.length === 0) continue;
    affected.push({ id: file.id, name: file.name, tools, toolApproval });
  }
  return affected;
}
