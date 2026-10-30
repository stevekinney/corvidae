/**
 * `bureau.deployment.get` and `bureau.agents.list`: what this Bureau is, and which
 * agents it has. Neither reads a resource with an owner.
 *
 * What a caller may see of the agents follows `bureau.agents:read` (COR-1904): a caller holding
 * it sees every ready agent, and a caller without it, such as an A2A credential, sees only the
 * agents that opt into A2A ({@link agentsVisibleTo}). `bureau.deployment.get` names every agent
 * and every operation, so it requires the scope.
 *
 * `bureau.deployment.get` returns exactly five keys and no other configuration:
 * the Bureau's identity, its lifecycle state, the agents it has, the
 * operations it serves with their schema versions, and its recovery status. A
 * test compares the key set.
 *
 * @module deployment-operations
 */

import { defineOperation, type Principal } from '@lostgradient/weft';
import { z } from 'zod';

import type { AgentMediaCapabilities } from '../../agent-catalog.ts';
import { agentExamplesSchema } from '../../agent-examples.ts';
import { unaryTransports as transports, unknownKeyPolicy } from './management-schemas.ts';

/** One operation the handler serves. */
export type OperationDescriptor = {
  readonly name: string;
  readonly kind: 'query' | 'command' | 'subscription';
  readonly schemaVersion: number;
};

/** One agent the deployment lists: ready, and startable. */
export type ListedAgent = {
  readonly name: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly definitionRevision: number;
  /** `code` for a code-defined agent, `file` for a persisted one. */
  readonly kind: 'code' | 'file';
  /**
   * Whether the agent opts into A2A: a persisted agent's `a2a` frontmatter, or the handler's
   * `a2aAgents` allowlist for a code-defined agent.
   */
  readonly a2a: boolean;
  /** What the agent's model takes in the way of media, or `null` when it names no model descriptor. */
  readonly media: AgentMediaCapabilities | null;
  /**
   * The names of the tools the agent has, in the order it lists them: a code-defined agent's
   * `toolNames` (Operative's `createAgent` states them), a file agent's `tools` frontmatter. Absent
   * when the agent does not say, which is not the same as having none (`[]`).
   */
  readonly tools?: readonly string[];
  /**
   * Prompts that show what a person might ask the agent, which a new chat offers as buttons: a
   * code-defined agent's `examples`, a file agent's `examples` frontmatter. Absent when the agent
   * has none.
   */
  readonly examples?: readonly string[];
};

/** The scope that shows a caller every ready agent rather than only the A2A ones. */
export const AGENTS_WIDE_VIEW_SCOPE = 'bureau.agents:read';

/**
 * The agents `principal` may see (COR-1904): every listed agent when it holds `bureau.agents:read`,
 * which the deployment's owner does, and otherwise only the agents that opt into A2A, so a
 * credential handed to A2A clients learns nothing of the agents the deployment does not offer them.
 * `bureau.agents.list` and `bureau.agents.models` both read through it.
 */
export function agentsVisibleTo(
  principal: Principal,
  agents: readonly ListedAgent[],
): readonly ListedAgent[] {
  return holdsWideView(principal) ? agents : agents.filter((agent) => agent.a2a);
}

function holdsWideView(principal: Principal): boolean {
  return principal.method !== 'unauthenticated' && principal.hasScope(AGENTS_WIDE_VIEW_SCOPE);
}

/**
 * Whether `principal` may name `agentName` where an operation starts or schedules it (COR-1904):
 * always with `bureau.agents:read`, so the owner starts any ready agent as before (COR-1864), and
 * otherwise only when {@link agentsVisibleTo} lists it. A caller that may not name an agent is
 * answered as if it did not exist. Whether the agent exists is the caller's own check.
 */
export function mayNameAgent(
  principal: Principal,
  agentName: string,
  agents: () => readonly ListedAgent[],
): boolean {
  if (holdsWideView(principal)) return true;
  return agentsVisibleTo(principal, agents()).some((agent) => agent.name === agentName);
}

/** What the operations that start or schedule an agent read to decide who may name it. */
export type BureauAgentVisibilityHost = {
  readonly agentVisibility: {
    /** {@link mayNameAgent} over the deployment's listed agents. */
    readonly mayName: (principal: Principal, agentName: string) => boolean;
  };
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
    readonly agents: () => readonly ListedAgent[];
    readonly operations: () => readonly OperationDescriptor[];
    readonly recovery: () => Promise<DeploymentRecovery>;
  };
};

const deploymentGetInput = z.object({});
const deploymentGetOutput = z.object({
  id: z.string(),
  state: z.enum(['ready', 'draining', 'stopped']),
  agents: z.array(z.string()),
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
    'Returns the deployment’s identity (`BureauOptions.id`), its state (`ready`, `draining` once shutdown has closed admission, `stopped`), the names of the agents it has, the operations it serves with each one’s schema version, and its boot recovery status (`pending` while a deferred recovery has not finished). It returns nothing else of the deployment’s configuration. It requires `bureau.agents:read`, because it names every agent and every operation.',
  destructive: false,
  tags: ['Deployment'],
  inputSchema: deploymentGetInput,
  outputSchema: deploymentGetOutput,
  producibleFaults: ['InvalidParams'],
  access: { kind: 'scoped', scopes: { kind: 'allOf', scopes: [AGENTS_WIDE_VIEW_SCOPE] } },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ host }) => ({
    id: host.deployment.id,
    state: host.deployment.state(),
    agents: host.deployment.agents().map((agent) => agent.name),
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
      a2a: z.boolean(),
      media: z
        .object({
          modalities: z.record(z.string(), z.object({ input: z.boolean(), output: z.boolean() })),
          mimeFamilies: z.array(z.string()),
          mediaLimits: z.array(
            z.object({ modality: z.string(), maxBytes: z.number().int().nonnegative() }),
          ),
        })
        .nullable(),
      tools: z.array(z.string()).optional(),
      examples: agentExamplesSchema.optional(),
    }),
  ),
});

export const agentsListOperation = defineOperation<
  typeof agentsListInput,
  typeof agentsListOutput,
  BureauDeploymentOperationHost
>({
  name: 'bureau.agents.list',
  mcpExposable: true,
  summary: 'List the agents the caller may see',
  description:
    'Returns the agents the deployment has, in definition order: its `name` (the catalog key every other operation calls `agentName`), `displayName`, `description`, `definitionRevision`, `kind` (`code` for a code-defined agent, `file` for a persisted one), `a2a` (whether the agent opts into A2A: the handler’s `a2aAgents` allowlist names a code-defined agent, a persisted agent’s file says `a2a: true`), and `media` (what the agent’s model takes in the way of media, as `modalities`, `mimeFamilies` and per-part `mediaLimits`, or `null` when the agent names no model descriptor; for a routed agent, what every route takes), and `tools` (the names of the tools the agent has, which a code-defined agent states and a persisted agent names in its file; omitted when the agent does not say, which differs from `[]`), and `examples` (prompts that show what a person might ask the agent, which a code-defined agent states and a persisted agent lists in its file; omitted when the agent has none). A caller holding `bureau.agents:read` sees every agent that is ready, code-defined or persisted (`bureau.agents.definitions.*`); any other authenticated caller, such as an A2A credential, sees only the ready agents that opt into A2A. An invalid agent file is not listed.',
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
    agents: agentsVisibleTo(principal, host.deployment.agents()).map((agent) => ({
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      definitionRevision: agent.definitionRevision,
      kind: agent.kind,
      a2a: agent.a2a,
      media: agent.media,
      ...(agent.tools === undefined ? {} : { tools: [...agent.tools] }),
      ...(agent.examples === undefined ? {} : { examples: [...agent.examples] }),
    })),
  }),
});
