import { authorizeWorkspaceOperation } from '../workspace-authorization.ts';

/**
 * `bureau.skills.list`: the executable Agent Skills a deployment's host has discovered (COR-1818),
 * each with the source it came from and whether that source is trusted.
 *
 * Discovery and trust are the host's call (COR-752, Decision 1): the host reads its configured
 * skill directories, decides which sources it admits, and hands the result to the handler as
 * `BureauHandlerOptions.skills`. This operation only reports that standing. An untrusted skill is
 * listed, with `available: false` and the reason, and is refused where an agent would use it: the
 * skill client answers `source-untrusted` to an activation of it, and a write that names it in a
 * file's `skills` is refused `skill-not-grantable`. A Bureau whose host passed no skills
 * answers an empty list.
 *
 * A caller needs `bureau.agents:read`, the scope of the rest of the capabilities an agent is built
 * from (`bureau.agents.catalog`), unless it owns the deployment's agents; anyone else is refused
 * with `Forbidden`. No new scope: a skill is a part of an agent's definition.
 *
 * @module skills-operations
 */

import { defineOperation, type OperationFault } from '@lostgradient/backchannel';
import { z } from 'zod';

import { readInstructions, type SkillArtifactLoader } from '../../skills/client/artifact-loader.ts';
import type { SkillCatalogRevision } from '../../skills/discovery/catalog.ts';
import type { SkillSourceKind, SkillTrustState } from '../../skills/discovery/source.ts';
import { mayAccessAgents } from '../agent-access.ts';
import type { BureauOwnershipHost } from '../owner-predicate.ts';
import { unaryTransports as transports, unknownKeyPolicy } from './management-schemas.ts';

/** One configured skill source and the decision made about it. */
export interface SkillSourceStanding {
  /** The source's stable identifier, unique within the host's configuration. */
  readonly id: string;
  /** Where the source came from, which is what a trust policy decides on. */
  readonly kind: SkillSourceKind;
  /** The source's canonical location, as configured. */
  readonly location: string;
  /** The plugin that ships the source's skills, for a `plugin` source (COR-1873). */
  readonly plugin?: string | undefined;
  /** Whether the source is admitted. */
  readonly trust: SkillTrustState;
  /** Why the trust decision went the way it did. */
  readonly trustReason: string;
}

/** What the host has discovered and decided: a catalog revision and the sources behind it. */
export interface SkillsStanding {
  /** The catalog revision the host's agents are composed with. */
  readonly catalog: SkillCatalogRevision;
  /** Every configured source, including one that produced no skills. */
  readonly sources: readonly SkillSourceStanding[];
  /**
   * Why the host refuses to change trust, such as `deployment` for a host whose configuration
   * belongs to its deployment; absent when a trust change is allowed.
   */
  readonly trustLocked?: string | undefined;
}

/** What the skills operation reads from the handler's `host`. */
export type BureauSkillsOperationHost = BureauOwnershipHost & {
  readonly skills: {
    /** The host's current standing, or `undefined` when the host discovers no skills. */
    readonly standing: () => SkillsStanding | Promise<SkillsStanding> | undefined;
    /**
     * The deployment's tool catalog (COR-2009): each tool by the name an agent file uses, with the
     * skill that brings it (`skill`, from the tool's `metadata.skill`) or `null`. A skill lists the
     * tools that name it. Omitted, no skill brings tools.
     */
    readonly tools?: () => readonly { readonly name: string; readonly skill: string | null }[];
    /**
     * Reads a catalogued skill's files back, as an activation does (`bureau.skills.get`,
     * COR-2435): the loader refuses a symbolic link that leaves the skill's directory and files
     * that changed since discovery. Omitted, no skill's SKILL.md can be read.
     */
    readonly loadArtifact?: SkillArtifactLoader;
  };
};

const sourceKindSchema = z.enum(['project', 'user', 'built-in', 'remote', 'storage', 'plugin']);
const trustSchema = z.enum(['trusted', 'untrusted', 'revoked']);

const skillSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** The source the skill was read from. */
  source: z.object({
    id: z.string(),
    kind: sourceKindSchema,
    location: z.string(),
    /** The plugin that ships the skill, for a `plugin` source; otherwise `null`. */
    plugin: z.string().nullable(),
  }),
  /** The decision about the skill's source. */
  trust: trustSchema,
  trustReason: z.string(),
  /** Whether an agent may activate the skill: false for an untrusted source, a shadowed name, or an invalid skill. */
  available: z.boolean(),
  /** Why the skill is not available (`source-untrusted`, `source-revoked`, `shadowed`, `invalid`, `unreadable`). */
  unavailableReason: z.string().nullable(),
  /** The tools the skill's `allowed-tools` asks to keep; empty when it states none. A request, never a grant. */
  allowedTools: z.array(z.string()),
  /**
   * The tools the skill brings, by the name an agent file uses, sorted: the catalog tools whose
   * `metadata.skill` names it. Empty for a skill of instructions only.
   */
  tools: z.array(z.string()),
});

const sourceSchema = z.object({
  id: z.string(),
  kind: sourceKindSchema,
  location: z.string(),
  /** The plugin that ships the source's skills, for a `plugin` source; otherwise `null`. */
  plugin: z.string().nullable(),
  trust: trustSchema,
  trustReason: z.string(),
  /** How many skills the source contributed to the catalog, available or not. */
  skillCount: z.number().int().nonnegative(),
});

const listInput = z.object({});
const listOutput = z.object({
  /** The catalog revision the list describes; `null` when the host discovers no skills. */
  revision: z.number().int().nullable(),
  skills: z.array(skillSchema),
  sources: z.array(sourceSchema),
  /** Why a trust change is refused (`deployment` for a remote host); `null` when it is allowed. */
  trustLocked: z.string().nullable(),
});

/** `bureau.skills.list`. */
export const skillsListOperation = defineOperation<
  typeof listInput,
  typeof listOutput,
  BureauSkillsOperationHost
>({
  name: 'bureau.skills.list',
  authorize: authorizeWorkspaceOperation('bureau.skills.list'),
  mcpExposable: false,
  summary: 'List the executable skills and their sources',
  description:
    'Returns the executable Agent Skills the host discovered, ordered by name, each with its `name`, `description`, `source` (`id`, `kind`, `location`, and `plugin`, the plugin that ships a `plugin` skill, or `null`), `trust` (`trusted`, `untrusted` or `revoked`, with the `trustReason`), whether an agent may activate it (`available`, and `unavailableReason` when not) the tools its `allowed-tools` asks to keep (`allowedTools`, a request and never a grant) and the tools it brings (`tools`: the catalog tools whose `metadata.skill` names it, by the name an agent file uses, which `bureau.agents.catalog` lists with `source: "skill"`; empty for a skill of instructions only). A skill from an untrusted source is listed, and an activation of it is refused with `source-untrusted`. `sources` lists every configured source with its trust and how many skills it contributed, so a source that holds none is still visible; `trustLocked` is the reason the host refuses to change trust (`deployment` for a remote host), or `null`. These are not the descriptive skills an agent file declares (`skillDescriptors`). A host that discovers no skills answers an empty list. Requires `bureau.agents:read` unless the caller owns the deployment’s agents; anyone else is refused with `Forbidden`.',
  destructive: false,
  tags: ['Agents'],
  inputSchema: listInput,
  outputSchema: listOutput,
  producibleFaults: ['InvalidParams', 'Forbidden'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ host, principal }) => {
    if (!mayAccessAgents(host.ownership, principal, 'bureau.agents:read')) {
      throw {
        code: 'Forbidden',
        message: 'Listing skills requires bureau.agents:read',
        data: { reason: 'missing scope bureau.agents:read' },
      } satisfies OperationFault;
    }
    const standing = await host.skills.standing();
    if (standing === undefined) {
      return { revision: null, skills: [], sources: [], trustLocked: null };
    }
    const brought = new Map<string, string[]>();
    for (const tool of host.skills.tools?.() ?? []) {
      if (tool.skill === null) continue;
      brought.set(tool.skill, [...(brought.get(tool.skill) ?? []), tool.name]);
    }
    const counts = new Map<string, number>();
    for (const record of standing.catalog.records) {
      counts.set(record.sourceId, (counts.get(record.sourceId) ?? 0) + 1);
    }
    return {
      revision: standing.catalog.revision,
      skills: standing.catalog.records.map((record) => ({
        name: record.name,
        description: record.description,
        source: {
          id: record.sourceId,
          kind: record.sourceKind,
          location: record.sourceLocation,
          plugin: record.sourcePlugin ?? null,
        },
        trust: record.trust,
        trustReason: record.trustReason,
        available: record.available,
        unavailableReason: record.unavailableReason ?? null,
        allowedTools: [...record.allowedTools],
        tools: (brought.get(record.name) ?? []).toSorted(),
      })),
      sources: standing.sources.map((source) => ({
        id: source.id,
        kind: source.kind,
        location: source.location,
        plugin: source.plugin ?? null,
        trust: source.trust,
        trustReason: source.trustReason,
        skillCount: counts.get(source.id) ?? 0,
      })),
      trustLocked: standing.trustLocked ?? null,
    };
  },
});

/** The most bytes of a skill's SKILL.md `bureau.skills.get` returns; a longer file is cut. */
export const MAXIMUM_SKILL_INSTRUCTIONS_BYTES = 64 * 1024;

/** The longest skill name `bureau.skills.get` reads: the Agent Skills limit, with room. */
const MAXIMUM_SKILL_NAME_LENGTH = 128;

const getInput = z.object({
  name: z
    .string()
    .min(1)
    .max(MAXIMUM_SKILL_NAME_LENGTH)
    .describe('The skill’s `name`, as `bureau.skills.list` lists it. Never a path.'),
});
const getOutput = z.object({
  /** The skill's name, as asked. */
  name: z.string(),
  /**
   * Its SKILL.md as the host catalogued it: the file's text (frontmatter and body), cut at
   * `MAXIMUM_SKILL_INSTRUCTIONS_BYTES`, the file's whole size in bytes, and whether the text was
   * cut. `null` when it cannot be served, and `unavailableReason` says why.
   */
  instructions: z
    .object({ text: z.string(), size: z.number().int().nonnegative(), truncated: z.boolean() })
    .nullable(),
  /**
   * Why `instructions` is `null`: `not-found` (no skill of that name is catalogued), `changed`
   * (its files changed since they were catalogued), or `unavailable` (they cannot be read back, such
   * as a skill that does not live in a directory); `null` when they are served.
   */
  unavailableReason: z.enum(['not-found', 'changed', 'unavailable']).nullable(),
});

/** Whether `name` is one directory entry: no separator, and not `.` or `..`. */
function isOneEntry(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[/\\]/.test(name);
}

/** `text` cut to at most `limit` bytes of UTF-8, never in the middle of a character. */
function cutToBytes(
  text: string,
  limit: number,
): { text: string; size: number; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= limit) return { text, size: bytes.byteLength, truncated: false };
  let end = limit;
  // A continuation byte (10xxxxxx) starts no character: back up to the first byte of one.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return {
    text: new TextDecoder().decode(bytes.subarray(0, end)),
    size: bytes.byteLength,
    truncated: true,
  };
}

/**
 * `bureau.skills.get` (COR-2435): what one catalogued skill tells an agent, its SKILL.md, for a
 * person to read before an agent loads it. It is a read, never an activation: nothing enters a
 * run, and an untrusted skill's file is shown as it is.
 *
 * The skill is named, never addressed by a path: the operation finds the catalog record of that
 * name and reads that record's own SKILL.md back through the artifact loader, which refuses a
 * symbolic link that leaves the skill's directory and a file that changed since it was catalogued.
 * A record whose directory is not one entry under its source is refused too. Authorized like
 * `bureau.skills.list`: `bureau.agents:read`, unless the caller owns the deployment's agents.
 */
export const skillsGetOperation = defineOperation<
  typeof getInput,
  typeof getOutput,
  BureauSkillsOperationHost
>({
  name: 'bureau.skills.get',
  authorize: authorizeWorkspaceOperation('bureau.skills.get'),
  mcpExposable: false,
  summary: 'Read one skill’s SKILL.md',
  description: `Returns one executable skill’s SKILL.md as the host catalogued it, named by the skill’s \`name\` (never a path): \`instructions\` holds the file’s \`text\` (frontmatter and body), cut at ${String(MAXIMUM_SKILL_INSTRUCTIONS_BYTES)} bytes (\`truncated\`), and its whole \`size\` in bytes. It reads only the catalog record’s own SKILL.md, refusing a symbolic link that leaves the skill’s directory and a file that changed since it was catalogued. \`instructions\` is \`null\` with \`unavailableReason\` \`not-found\` for a name no skill has, \`changed\` for files that changed since discovery, and \`unavailable\` for files that cannot be read back. A read is never an activation: an untrusted skill’s file is shown too, and nothing enters a run. Requires \`bureau.agents:read\` unless the caller owns the deployment’s agents; anyone else is refused with \`Forbidden\`.`,
  destructive: false,
  tags: ['Agents'],
  inputSchema: getInput,
  outputSchema: getOutput,
  producibleFaults: ['InvalidParams', 'Forbidden'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ host, principal, input }) => {
    // The scope is checked before the catalog is read, so a refusal says nothing of what exists.
    if (!mayAccessAgents(host.ownership, principal, 'bureau.agents:read')) {
      throw {
        code: 'Forbidden',
        message: 'Reading a skill requires bureau.agents:read',
        data: { reason: 'missing scope bureau.agents:read' },
      } satisfies OperationFault;
    }
    const name = input.name;
    const unavailable = (reason: 'not-found' | 'changed' | 'unavailable') => ({
      name,
      instructions: null,
      unavailableReason: reason,
    });
    const standing = await host.skills.standing();
    // The record an agent would load: the available one of that name, else the first listed.
    const records = standing?.catalog.records.filter((record) => record.name === name) ?? [];
    const record = records.find((candidate) => candidate.available) ?? records[0];
    if (record === undefined) return unavailable('not-found');
    if (record.directoryName !== undefined && !isOneEntry(record.directoryName)) {
      return unavailable('unavailable');
    }
    const load = host.skills.loadArtifact;
    if (load === undefined) return unavailable('unavailable');
    let loaded: Awaited<ReturnType<typeof load>>;
    try {
      loaded = await load(record);
    } catch {
      return unavailable('unavailable');
    }
    if (!loaded.loaded)
      return unavailable(loaded.failure === 'changed' ? 'changed' : 'unavailable');
    const text = readInstructions(loaded.artifact);
    if (text === undefined) return unavailable('unavailable');
    return {
      name,
      instructions: cutToBytes(text, MAXIMUM_SKILL_INSTRUCTIONS_BYTES),
      unavailableReason: null,
    };
  },
});

/** The skills operations, in the order the handler serves them. */
export const bureauSkillsOperations = [skillsListOperation, skillsGetOperation] as const;
