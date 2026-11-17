/**
 * The last tool listing of each tool source and plugin, kept across restarts (COR-2435, owner
 * decision 2026-11-17): a source that fails to connect, waits for a sign-in, or a plugin that is
 * disabled still shows the tools it offered the last time it listed them, so Capabilities can say
 * "GitHub is disconnected" on the tool rather than losing it.
 *
 * - **Where it lives.** One record per owner in the host's storage, under
 *   {@link TOOL_LISTING_KEY_PREFIX}: `source:<id>` for a tool source, `plugin:<digest>` for a plugin,
 *   the digest being of where it was loaded from (its `source` and `location`), since two plugins can
 *   share a name. Not in `configuration.json`: that file is the owner's, a write there moves the
 *   revision every editor fences on, and a remote home cannot write it.
 * - **The record.** `{ schemaVersion: 1, revision, listedAt, tools, truncated }`. `revision` is what
 *   the listing was made for: a source's description digest, so a source that now points somewhere
 *   else, or a new source that reuses an id, reads as "no listing known". `tools` holds, for each
 *   tool, the name an agent file uses, its own name, its title, its descriptions, its tier and its
 *   input schema, never a value it was called with.
 * - **Only a success replaces it.** {@link ToolListingMemory.remember} is called after a listing
 *   succeeded and never after a failure, so the last good listing stays. A failed write is reported
 *   to the caller's warning and never fails the load it follows.
 * - **Bounded.** At most {@link MAXIMUM_REMEMBERED_TOOLS} tools, each text cut to its limit, and
 *   the whole record within {@link MAXIMUM_LISTING_BYTES}: input schemas are dropped from the end
 *   until it fits, and `truncated` says that something was left out.
 * - **Records from before.** A key that is absent, or holds a record this reader cannot parse, is
 *   "no listing known": never an error.
 *
 * @module tool-listing-memory
 */

import { createHash } from 'node:crypto';

import type { Storage } from '@lostgradient/storage';
import { z } from 'zod';

/** The storage key prefix of every remembered listing. */
export const TOOL_LISTING_KEY_PREFIX = 'interborough-tool-listing:';

/** The most tools one remembered listing holds. */
export const MAXIMUM_REMEMBERED_TOOLS = 128;

/** The longest a remembered tool's title may be, in characters. */
export const MAXIMUM_REMEMBERED_TITLE_LENGTH = 120;

/** The longest a remembered tool's descriptions may be, in characters. */
export const MAXIMUM_REMEMBERED_DESCRIPTION_LENGTH = 500;

/** The most bytes one remembered listing may take, encoded. */
export const MAXIMUM_LISTING_BYTES = 256 * 1024;

const TIERS = ['read-only', 'mutating', 'dangerous'] as const;

const rememberedToolSchema = z.object({
  name: z.string().min(1),
  tool: z.string().min(1),
  title: z.string().nullable(),
  description: z.string(),
  shortDescription: z.string().nullable(),
  tier: z.enum(TIERS).nullable(),
  inputSchema: z.record(z.string(), z.unknown()).nullable(),
});

const recordSchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.string(),
  listedAt: z.string(),
  tools: z.array(rememberedToolSchema).max(MAXIMUM_REMEMBERED_TOOLS),
  truncated: z.boolean(),
});

/** One tool as a listing remembers it. */
export type RememberedTool = z.infer<typeof rememberedToolSchema>;

/** A listing as it is read back. */
export type ToolListingRecord = z.infer<typeof recordSchema>;

/** What a tool offers to be remembered: any string is cut to its limit, an unknown tier is `null`. */
export type RememberedToolInput = {
  readonly name: string;
  readonly tool: string;
  readonly title: string | null | undefined;
  readonly description: string | null | undefined;
  readonly shortDescription: string | null | undefined;
  readonly tier: string | null | undefined;
  readonly inputSchema: Readonly<Record<string, unknown>> | null | undefined;
};

/** The owner key of a tool source's listing. */
export function sourceListingOwner(id: string): string {
  return `source:${id}`;
}

/** The owner key of a plugin's listing: by where it was loaded from, since two plugins may share a name. */
export function pluginListingOwner(plugin: {
  readonly source: string;
  readonly location: string;
}): string {
  const digest = createHash('sha256')
    .update(`${plugin.source}\u0000${plugin.location}`)
    .digest('hex')
    .slice(0, 32);
  return `plugin:${digest}`;
}

function cut(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function bytesOf(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** A tool as a listing keeps it, every field within its bound. */
function rememberedToolOf(input: RememberedToolInput): RememberedTool {
  const tier = TIERS.find((known) => known === input.tier) ?? null;
  let inputSchema: Record<string, unknown> | null = null;
  if (input.inputSchema !== null && input.inputSchema !== undefined) {
    try {
      inputSchema = structuredClone({ ...input.inputSchema });
    } catch {
      inputSchema = null;
    }
  }
  return {
    name: input.name,
    tool: input.tool,
    title:
      input.title === null || input.title === undefined || input.title.trim() === ''
        ? null
        : cut(input.title, MAXIMUM_REMEMBERED_TITLE_LENGTH),
    description: cut(input.description ?? '', MAXIMUM_REMEMBERED_DESCRIPTION_LENGTH),
    shortDescription:
      input.shortDescription === null || input.shortDescription === undefined
        ? null
        : cut(input.shortDescription, MAXIMUM_REMEMBERED_DESCRIPTION_LENGTH),
    tier,
    inputSchema,
  };
}

/**
 * The record to store for `tools`, listed for `revision` at `listedAt`: at most
 * {@link MAXIMUM_REMEMBERED_TOOLS} tools, and within {@link MAXIMUM_LISTING_BYTES}, input schemas
 * dropped from the last tool back until it fits.
 */
export function listingRecord(
  revision: string,
  listedAt: string,
  tools: readonly RememberedToolInput[],
): ToolListingRecord {
  const kept = tools.slice(0, MAXIMUM_REMEMBERED_TOOLS).map(rememberedToolOf);
  let truncated = tools.length > kept.length;
  const record: ToolListingRecord = {
    schemaVersion: 1,
    revision,
    listedAt,
    tools: kept,
    truncated,
  };
  for (
    let index = kept.length - 1;
    index >= 0 && bytesOf(record) > MAXIMUM_LISTING_BYTES;
    index--
  ) {
    const tool = kept[index];
    if (tool !== undefined && tool.inputSchema !== null) {
      kept[index] = { ...tool, inputSchema: null };
      truncated = true;
    }
  }
  // Each field is bounded, so without schemas the record fits; this only keeps the promise exact.
  while (kept.length > 0 && bytesOf({ ...record, tools: kept }) > MAXIMUM_LISTING_BYTES) {
    kept.pop();
    truncated = true;
  }
  return { ...record, tools: kept, truncated };
}

/** The last listings, read and written. */
export type ToolListingMemory = {
  /**
   * The last listing `owner` made, or `undefined` when none is known: none was stored, it cannot be
   * read, or it was made for another `revision` (when one is given).
   */
  read(owner: string, revision?: string): Promise<ToolListingRecord | undefined>;
  /** Replace the last listing of `owner` with a successful one. Call it only after a listing succeeded. */
  remember(owner: string, revision: string, tools: readonly RememberedToolInput[]): Promise<void>;
  /** Forget the listing of `owner`: the source or plugin is gone. */
  forget(owner: string): Promise<void>;
};

/**
 * Keep the tools each running plugin contributes as its last listing (COR-2435), read from the
 * Bureau's catalog once it is built: `plugins` is `bureau.plugins.list()` and `tools` is
 * `bureau.agents.tools()`. A plugin that is not running lists nothing and is left alone, so its
 * last listing stays. Best effort: a write that fails is a warning.
 */
export async function rememberPluginListings(
  memory: ToolListingMemory,
  plugins: readonly {
    readonly descriptor: { readonly name: string; readonly version: string };
    readonly source: string;
    readonly location: string;
    readonly status: string;
  }[],
  tools: readonly (Omit<RememberedToolInput, 'tool'> & {
    readonly source: string;
    readonly plugin: string | null;
  })[],
  warn: (message: string) => void,
): Promise<void> {
  for (const plugin of plugins) {
    if (plugin.status !== 'running' && plugin.status !== 'needs-setup') continue;
    const contributed = tools
      .filter((tool) => tool.source === 'plugin' && tool.plugin === plugin.descriptor.name)
      .map((tool) => ({ ...tool, tool: tool.name }));
    try {
      await memory.remember(pluginListingOwner(plugin), plugin.descriptor.version, contributed);
    } catch {
      warn(
        `Plugin "${plugin.descriptor.name}" listed its tools, but the listing could not be kept.`,
      );
    }
  }
}

/** The memory over `storage`. `now` stamps a listing. */
export function createToolListingMemory(
  storage: Pick<Storage, 'get' | 'put' | 'delete'>,
  now: () => number = Date.now,
): ToolListingMemory {
  const keyOf = (owner: string): string => `${TOOL_LISTING_KEY_PREFIX}${owner}`;
  return {
    async read(owner, revision) {
      let bytes: Uint8Array | null;
      try {
        bytes = await storage.get(keyOf(owner));
      } catch {
        return undefined;
      }
      if (bytes === null || bytes.byteLength > MAXIMUM_LISTING_BYTES) return undefined;
      let parsed: ReturnType<typeof recordSchema.safeParse>;
      try {
        parsed = recordSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
      } catch {
        return undefined;
      }
      if (!parsed.success) return undefined;
      if (revision !== undefined && parsed.data.revision !== revision) return undefined;
      return parsed.data;
    },
    async remember(owner, revision, tools) {
      const record = listingRecord(revision, new Date(now()).toISOString(), tools);
      await storage.put(keyOf(owner), new TextEncoder().encode(JSON.stringify(record)));
    },
    async forget(owner) {
      await storage.delete(keyOf(owner));
    },
  };
}
