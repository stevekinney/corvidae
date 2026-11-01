/**
 * `bureau.skills.list`: the executable Agent Skills a deployment's host has discovered (COR-1818),
 * each with the source it came from and whether that source is trusted.
 *
 * Discovery and trust are the host's call (COR-752, Decision 1): the host reads its configured
 * skill directories, decides which sources it admits, and hands the result to the handler as
 * `BureauHandlerOptions.skills`. This operation only reports that standing. An untrusted skill is
 * listed, with `available: false` and the reason, and is refused where an agent would use it: the
 * skill client answers `source-untrusted` to an activation of it, and a write that names it in a
 * file's `allowedSkills` is refused `skill-not-grantable`. A Bureau whose host passed no skills
 * answers an empty list.
 *
 * A caller needs `bureau.agents:read`, the scope of the rest of the capabilities an agent is built
 * from (`bureau.agents.catalog`), unless it owns the deployment's agents; anyone else is refused
 * with `Forbidden`. No new scope: a skill is a part of an agent's definition.
 *
 * @module skills-operations
 */

import { defineOperation, type OperationFault } from '@lostgradient/weft';
import { z } from 'zod';

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
  mcpExposable: false,
  summary: 'List the executable skills and their sources',
  description:
    'Returns the executable Agent Skills the host discovered, ordered by name, each with its `name`, `description`, `source` (`id`, `kind`, `location`, and `plugin`, the plugin that ships a `plugin` skill, or `null`), `trust` (`trusted`, `untrusted` or `revoked`, with the `trustReason`), whether an agent may activate it (`available`, and `unavailableReason` when not) and the tools its `allowed-tools` asks to keep (`allowedTools`, a request and never a grant). A skill from an untrusted source is listed, and an activation of it is refused with `source-untrusted`. `sources` lists every configured source with its trust and how many skills it contributed, so a source that holds none is still visible; `trustLocked` is the reason the host refuses to change trust (`deployment` for a remote host), or `null`. These are not the descriptive skills an agent file declares (`skillDescriptors`). A host that discovers no skills answers an empty list. Requires `bureau.agents:read` unless the caller owns the deployment’s agents; anyone else is refused with `Forbidden`.',
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

/** The skills operations, in the order the handler serves them. */
export const bureauSkillsOperations = [skillsListOperation] as const;
