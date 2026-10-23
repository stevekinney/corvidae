/**
 * `bureau.deployment.get` and `bureau.agents.list`: what this Bureau is, and which
 * agents it publishes. Both need only authentication; neither reads a resource
 * with an owner.
 *
 * `bureau.deployment.get` returns exactly five keys and no other configuration:
 * the Bureau's identity, its lifecycle state, the agents it publishes, the
 * operations it serves with their schema versions, and its recovery status. A
 * test compares the key set.
 *
 * @module deployment-operations
 */

import { defineOperation } from '@lostgradient/weft';
import { z } from 'zod';

import type { AgentMediaCapabilities } from '../../agent-catalog.ts';
import { mayDiscloseUnpublishedAgents } from '../agent-access.ts';
import type { BureauOwnershipHost } from '../owner-predicate.ts';
import { unaryTransports as transports, unknownKeyPolicy } from './management-schemas.ts';

/** One operation the handler serves. */
export type OperationDescriptor = {
  readonly name: string;
  readonly kind: 'query' | 'command' | 'subscription';
  readonly schemaVersion: number;
};

/** One published agent. */
export type PublishedAgent = {
  readonly name: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly definitionRevision: number;
  /** `code` for a code-defined agent, `file` for a persisted one. */
  readonly kind: 'code' | 'file';
  /**
   * `withdrawn` for a persisted agent whose file does not publish it, and `unpublished` for a
   * code-defined agent the `publish` allowlist does not name.
   */
  readonly publishState: 'published' | 'withdrawn' | 'unpublished';
  /** What the agent's model takes in the way of media, or `null` when it names no model descriptor. */
  readonly media: AgentMediaCapabilities | null;
};

/**
 * Every operation's schema version today. An operation's wire contract changing
 * incompatibly is a new operation name or a bump here, so a client that pins a
 * version can tell the deployment still speaks it.
 */
export const OPERATION_SCHEMA_VERSION = 1;

/**
 * The served operations as the deployment reports them. Derived from the operations
 * themselves, so one added to the handler is listed without a second edit: a
 * subscription is a `subscription`, a destructive unary operation a `command`, and
 * any other a `query`.
 */
export function describeOperations(
  operations: readonly {
    readonly name: string;
    readonly kind?: 'unary' | 'stream' | 'subscription' | undefined;
    readonly destructive: boolean;
  }[],
): readonly OperationDescriptor[] {
  return operations.map((operation) => ({
    name: operation.name,
    kind:
      operation.kind === 'subscription' || operation.kind === 'stream'
        ? 'subscription'
        : operation.destructive
          ? 'command'
          : 'query',
    schemaVersion: OPERATION_SCHEMA_VERSION,
  }));
}

export type DeploymentRecovery = {
  readonly status: 'not-applicable' | 'pending' | 'clean' | 'partial' | 'failed';
  readonly failedRunCount: number;
};

/** What the deployment operations read from the handler's `host`. */
export type BureauDeploymentOperationHost = {
  readonly deployment: {
    readonly id: string;
    readonly state: () => 'ready' | 'draining' | 'stopped';
    readonly publishedAgents: () => readonly PublishedAgent[];
    readonly operations: () => readonly OperationDescriptor[];
    readonly recovery: () => Promise<DeploymentRecovery>;
  };
};

const deploymentGetInput = z.object({});
const deploymentGetOutput = z.object({
  id: z.string(),
  state: z.enum(['ready', 'draining', 'stopped']),
  publishedAgents: z.array(z.string()),
  operations: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(['query', 'command', 'subscription']),
      schemaVersion: z.number().int().positive(),
    }),
  ),
  recovery: z.object({
    status: z.enum(['not-applicable', 'pending', 'clean', 'partial', 'failed']),
    failedRunCount: z.number().int().nonnegative(),
  }),
});

export const deploymentGetOperation = defineOperation<
  typeof deploymentGetInput,
  typeof deploymentGetOutput,
  BureauDeploymentOperationHost
>({
  name: 'bureau.deployment.get',
  mcpExposable: false,
  summary: 'Describe this deployment',
  description:
    'Returns the deployment’s identity (`BureauOptions.id`), its state (`ready`, `draining` once shutdown has closed admission, `stopped`), the names of the agents it publishes, the operations it serves with each one’s schema version, and its boot recovery status (`pending` while a deferred recovery has not finished). It returns nothing else of the deployment’s configuration. Any authenticated principal may read it.',
  destructive: false,
  tags: ['Deployment'],
  inputSchema: deploymentGetInput,
  outputSchema: deploymentGetOutput,
  producibleFaults: ['InvalidParams'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ host }) => ({
    id: host.deployment.id,
    state: host.deployment.state(),
    publishedAgents: host.deployment
      .publishedAgents()
      .filter((agent) => agent.publishState === 'published')
      .map((agent) => agent.name),
    operations: host.deployment.operations().map((operation) => ({ ...operation })),
    recovery: { ...(await host.deployment.recovery()) },
  }),
});

const agentsListInput = z.object({});
const agentsListOutput = z.object({
  agents: z.array(
    z.object({
      name: z.string(),
      displayName: z.string(),
      description: z.string().nullable(),
      definitionRevision: z.number().int().positive(),
      kind: z.enum(['code', 'file']),
      publishState: z.enum(['published', 'withdrawn', 'unpublished']),
      media: z
        .object({
          modalities: z.record(z.string(), z.object({ input: z.boolean(), output: z.boolean() })),
          mimeFamilies: z.array(z.string()),
          mediaLimits: z.array(
            z.object({ modality: z.string(), maxBytes: z.number().int().nonnegative() }),
          ),
        })
        .nullable(),
    }),
  ),
});

export const agentsListOperation = defineOperation<
  typeof agentsListInput,
  typeof agentsListOutput,
  BureauDeploymentOperationHost & BureauOwnershipHost
>({
  name: 'bureau.agents.list',
  mcpExposable: true,
  summary: 'List the agents the caller may see',
  description:
    'Returns the agents the deployment publishes, in definition order: its `name` (the catalog key every other operation calls `agentName`), `displayName`, `description`, `definitionRevision`, `kind` (`code` for a code-defined agent, `file` for a persisted one), `publishState`, and `media` (what the agent’s model takes in the way of media, as `modalities`, `mimeFamilies` and per-part `mediaLimits`, or `null` when the agent names no model descriptor; for a routed agent, what every route takes). A code-defined agent is `published` when the `publish` allowlist names it, and any authenticated principal sees it then. A caller who owns the deployment’s agents or holds `bureau.agents:read` also sees the code-defined agents the allowlist does not name, as `unpublished`; to anyone else those agents do not exist. A persisted agent (`bureau.agents.definitions.*`) is published by its own file. Any authenticated principal sees the published agents. A caller who owns the deployment’s agents or holds `bureau.agents:read` also sees the persisted agents that are ready and not published, as `withdrawn`; to anyone else those agents do not exist, as they do not in `bureau.agents.definitions.get`. An invalid agent file is not listed.',
  destructive: false,
  tags: ['Deployment'],
  inputSchema: agentsListInput,
  outputSchema: agentsListOutput,
  producibleFaults: ['InvalidParams'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ host, principal }) => ({
    agents: host.deployment
      .publishedAgents()
      .filter(
        (agent) =>
          agent.publishState === 'published' ||
          mayDiscloseUnpublishedAgents(host.ownership, principal),
      )
      .map((agent) => ({
        name: agent.name,
        displayName: agent.displayName,
        description: agent.description,
        definitionRevision: agent.definitionRevision,
        kind: agent.kind,
        publishState: agent.publishState,
        media: agent.media,
      })),
  }),
});
