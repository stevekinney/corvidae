/**
 * `bureau.agents.definitions.*` and `bureau.agents.catalog`: the agent definitions of a Bureau
 * (COR-1526), written, read, and deleted through the same Markdown files a
 * person edits by hand (COR-1524), and the models and tools those files may name.
 *
 * `bureau.agents.try` (COR-1911) takes a definition that is not saved and starts a throwaway context
 * with it; it needs `bureau.agents:write`, as `create` does, and writes no file.
 *
 * `bureau.agents.versions.list` and `bureau.agents.versions.restore` (COR-1815) keep the saved
 * versions of an agent apart from its runs: `list` is read like `revisions`, and `restore` is
 * written like `update`. A `savedBy` on a version is the caller's owner string, so a save through
 * these operations is distinguishable from an edit made to the file by hand, which has none.
 *
 * Every agent belongs to the deployment's owner of record, and there is no owner field in a file.
 * A caller reaches the definitions it owns without any scope; `bureau.agents:read` grants `get`,
 * `list`, `revisions`, and `catalog` to any caller, and `bureau.agents:write` grants `create`,
 * `update`, and `delete`, and neither implies the other. A caller that may
 * not see definitions is answered as if there were none: an empty page, or `NotFound`. `create`
 * and `catalog` have no resource to hide, so a caller who may not use them is refused with
 * `Forbidden`.
 *
 * Operations address an agent by its identifier, which is its filename without `.md`, or the key
 * of a code-defined agent, never by its display name. A code-defined agent can be read and listed
 * but not written: an `update` or `delete` of one is answered `NotFound`.
 *
 * A write fails with a typed `Conflict` (`data.reason` is `agent-file-exists`, or
 * `shadows-code-agent` for the key of a code-defined agent) when the identifier is taken, with
 * `StaleRevision` (`data.expectedRevision` is the hash the caller sent and `data.currentRevision`
 * the hash of what is on disk) when the file changed since the caller read it, and with
 * `Unprocessable` (`data.reason` is the problem code) when the result would not load; each writes
 * nothing. Every write that changed a file is appended to the audit trail, filed under
 * `agent:<identifier>` and attributed to the caller.
 *
 * @module agent-definitions-operations
 */

import {
  type BackendDescriptor,
  projectDescriptor,
  type AgentSkillDescriptor,
} from '@lostgradient/operative';
import { defineOperation, type OperationFault, type Principal } from '@lostgradient/weft';
import { z } from 'zod';

import type { AgentDefinitions } from '../../agent-catalog.ts';
import type { BureauAgents } from '../../types.ts';
import {
  AGENT_IDENTIFIER_MAX_LENGTH,
  agentCompactionSchema,
  agentCostBudgetSchema,
  agentReferencesSchema,
  agentContributionIdsSchema,
  agentRetrySchema,
  agentToolApprovalSchema,
  agentToolBudgetSchema,
  agentSkillDescriptorSchema,
  agentStepLimitSchema,
  AgentFileConflictError,
  AgentFileError,
  checkModelsList,
  type AgentFileDefinition,
  type AgentFileDefinitionInput,
} from '../../agent-file.ts';
import type {
  AgentCodeDefinition,
  AgentFileDetail,
  AgentListing,
} from '../../agent-file-catalog.ts';
import { auditTrailAgentOwnerId } from '../../audit-trail.ts';
import { BureauError } from '../../create-bureau.ts';
import { mayAccessAgents } from '../agent-access.ts';
import type { BureauScope } from '../bureau-scopes.ts';
import { type BureauOwnershipHost, ownerOfPrincipal } from '../owner-predicate.ts';
import {
  DEFAULT_PAGE_LIMIT,
  pageFields,
  resourceNotFound,
  unaryTransports as transports,
  unknownKeyPolicy,
} from './management-schemas.ts';

/** One entry of the audit trail, as the operations write it. */
export interface AgentDefinitionAuditEntry {
  readonly runId: string;
  readonly type: 'agent.created' | 'agent.updated' | 'agent.deleted';
  readonly detail: { readonly id: string; readonly hash: string; readonly previousHash?: string };
  /** The caller's owner string; absent for a caller the deployment cannot attribute. */
  readonly principal?: string;
}

/** What the agent definition operations read from the handler's `host`. */
export type BureauAgentDefinitionsOperationHost = BureauOwnershipHost & {
  readonly agentDefinitions: {
    readonly agents: Pick<
      BureauAgents<AgentDefinitions>,
      | 'list'
      | 'detail'
      | 'tools'
      | 'revisions'
      | 'versions'
      | 'create'
      | 'update'
      | 'delete'
      | 'try'
    >;
    /** Whether the `a2a` allowlist of `createBureauHandler` names the code-defined agent `id`. */
    readonly optsCodeAgentIntoA2A: (id: string) => boolean;
    /** The rows of the deployment's model catalog, as the catalog holds them. */
    readonly models: () => readonly BackendDescriptor[];
    /** Appends to the durable audit trail; resolves without writing when the Bureau keeps none. */
    readonly audit: (entry: AgentDefinitionAuditEntry) => Promise<void>;
  };
};

/** The same cap the file format has, so no identifier a request can name is one no file can have. */
const agentIdentifier = z
  .string()
  .min(1)
  .max(AGENT_IDENTIFIER_MAX_LENGTH)
  .describe('The identifier of the agent.');
const hash = z
  .string()
  .min(1)
  .describe(
    'The `hash` of the agent file the caller read; a file that has changed since is a `StaleRevision` fault and nothing is written.',
  );

const problemSchema = z.object({
  code: z.string(),
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).nullable(),
});

const agentListingSchema = z.object({
  id: z.string(),
  source: z.enum(['code', 'file']),
  state: z.enum(['ready', 'invalid']),
  name: z.string(),
  description: z.string().nullable(),
  a2a: z.boolean(),
  owner: z.string(),
  hash: z.string().nullable(),
  definitionRevision: z.number().int().positive().nullable(),
  problem: problemSchema.nullable(),
  /** The plugin whose read-only layer ships the agent (`plugin:name`), or `null` for a code agent or an owner's file (COR-1873). */
  plugin: z.string().nullable(),
});

const definitionOutputSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  model: z.string(),
  /** The models a session of the agent may be switched to (COR-1559); `null` when the file lists none. */
  models: z.array(z.string()).nullable(),
  tools: z.array(z.string()),
  skillDescriptors: z.array(agentSkillDescriptorSchema),
  a2a: z.boolean(),
  /** The most steps one run may take; `null` when the file sets none and Operative's default applies. */
  stepLimit: z.number().int().nullable(),
  /** How a run retries a failed generate call; `null` when the file sets none and it does not. */
  retry: agentRetrySchema.nullable(),
  /** Whether and when a run compacts its conversation; `null` when the file sets none and it does not. */
  compaction: agentCompactionSchema.nullable(),
  /** The reference documents, as paths beside the file; `null` when the file lists none. */
  references: agentReferencesSchema.nullable(),
  /** The plugin guardrails (`plugin:name`) the file lists; `null` when it lists none, and only Operative's default applies. */
  guardrails: agentContributionIdsSchema.nullable(),
  /** The plugin run hooks (`plugin:name`) the file lists; `null` when it lists none. */
  hooks: agentContributionIdsSchema.nullable(),
  /** What one run may spend; `null` when the file sets no limit. */
  costBudget: agentCostBudgetSchema.nullable(),
  /** What one run's tools may use; `null` when the file sets no limit. */
  toolBudget: agentToolBudgetSchema.nullable(),
  /** When each tool asks a person first; `null` when the file sets none and every tool asks on changes. */
  toolApproval: agentToolApprovalSchema.nullable(),
  instructions: z.string(),
});

/** What a code-defined agent states about itself (COR-1818); read-only, since no file backs it. */
const codeDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  /** The model its next step would use, `<provider>/<model>`; `null` for a scripted or routed agent. */
  model: z.string().nullable(),
  /** The models a session may be switched to, `<provider>/<model>`; empty for a fixed, routed or opaque agent. */
  models: z.array(z.string()),
  tools: z.array(z.string()),
  /** The executable skills the agent can activate, by name; not `skillDescriptors`. */
  skills: z.array(z.string()),
  skillDescriptors: z.array(agentSkillDescriptorSchema),
  instructions: z.string().nullable(),
});

const agentDetailSchema = agentListingSchema.extend({
  definition: definitionOutputSchema.nullable(),
  /** A code-defined agent's own statement of itself; `null` for a file agent. */
  codeDefinition: codeDefinitionSchema.nullable(),
  text: z.string().nullable(),
});

/**
 * What a caller supplies to `create` or `update`. An update keeps `a2a`, `stepLimit`, `retry`,
 * `compaction`, `references`, `guardrails`, `hooks`, `costBudget`, `toolBudget` and `toolApproval` when it leaves them out,
 * so an editor that rewrites a definition cannot turn an agent's A2A opt-in off, or drop its step
 * limit, retry, compaction, references, guardrails, hooks, spend limit or tool approvals, by omitting
 * them; `null` removes any of them but `a2a`.
 */
const definitionInputSchema = z
  .strictObject({
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    model: z.string().min(1),
    /**
     * The models a session may be switched to (COR-1559), checked as a file's frontmatter is: each
     * entry `<provider>/<name>`, unique, the list not empty and including `model`. Omitting it (or
     * sending `null`, as `description` may) leaves the definition with no list: on `update` that
     * removes the file's list, exactly as omitting `tools` removes its tools. `get` answers `null`
     * for a file that lists none, as it does for a `description` it lacks.
     */
    models: z.array(z.string()).nullable().optional(),
    tools: z.array(z.string().min(1)).optional(),
    skillDescriptors: z.array(agentSkillDescriptorSchema).optional(),
    /** Whether the agent opts into A2A. Omitted, a create is `false` and an update keeps the file's value. */
    a2a: z.boolean().optional(),
    /**
     * The most steps one run may take, 1 to 1000. Omitted, a create sets none and an update keeps the
     * file's value; `null` removes the file's, so Operative's default applies again.
     */
    stepLimit: agentStepLimitSchema.nullable().optional(),
    /**
     * How a run retries a failed generate call. Omitted, a create sets none and an update keeps the
     * file's value; `null` removes the file's, so the run does not retry.
     */
    retry: agentRetrySchema.nullable().optional(),
    /**
     * Whether and when a run compacts its conversation, which needs a configured summarizer model.
     * Omitted, a create sets none and an update keeps the file's value; `null` removes the file's.
     */
    compaction: agentCompactionSchema.nullable().optional(),
    /**
     * Documents, as paths relative to the agent file's directory, whose text joins the agent's
     * instructions. Omitted, a create lists none and an update keeps the file's list; `null`, or an
     * empty list, removes it.
     */
    references: agentReferencesSchema.nullable().optional(),
    /**
     * The plugin guardrails (`plugin:name`, no version) the agent runs besides Operative's default
     * preset, which every agent runs. Omitted, a create lists none and an update keeps the file's
     * list; `null`, or an empty list, removes it. An id no plugin contributes is refused as
     * `reference-unresolved`.
     */
    guardrails: agentContributionIdsSchema.nullable().optional(),
    /**
     * The plugin run hooks (`plugin:name`, no version) the agent runs. Omitted, a create lists none
     * and an update keeps the file's list; `null`, or an empty list, removes it. An id no plugin
     * contributes is refused as `reference-unresolved`.
     */
    hooks: agentContributionIdsSchema.nullable().optional(),
    /**
     * What one run may spend: `perRunUsd` (a positive number of US dollars), `perChatUsd` (the most a chat may spend across its runs: once its earlier runs have spent it, the next run ends `budget-exceeded` before it starts) and `warnAt` (up to ten
     * fractions of it, each between 0 and 1, at which the run's activity shows a warning). The
     * agent's model must have a price in US dollars in the model catalog. Omitted, a create sets
     * no limit and an update keeps the file's; `null` removes the file's.
     */
    costBudget: agentCostBudgetSchema.nullable().optional(),
    /**
     * What one run's tools may use: `maxCalls` (a whole number of tool calls) and
     * `maxDurationSeconds` (how long, from the start of the run, its tools may be called); at
     * least one. The first call after a limit is reached ends the run, finish reason
     * `budget-exceeded`. Omitted, a create sets no limit and an update keeps the file's; `null`
     * removes the file's.
     */
    toolBudget: agentToolBudgetSchema.nullable().optional(),
    /**
     * When each tool asks a person before it runs: a tool name from `tools` mapped to `never`,
     * `on-changes`, `always` or `blocked`. A tool left out asks on changes. Omitted, a create sets
     * none and an update keeps the file's; `null` or an empty map removes the file's.
     */
    toolApproval: agentToolApprovalSchema.nullable().optional(),
    instructions: z.string(),
  })
  .superRefine((definition, context) => checkModelsList(definition, context))
  .describe(
    'The agent’s definition: `name`, `description`, `model`, `models` (the models a session may be switched to), `tools`, `skillDescriptors`, `a2a` (whether the agent opts into A2A), `stepLimit` (the most steps a run takes, 1 to 1000), `retry` (`attempts` 1 to 10, `delayMilliseconds` 0 to 60000, `jitter`), `compaction` (`enabled`, `thresholdPercent` 50 to 95), `references` (paths of documents beside the file, whose text joins the instructions), `guardrails` and `hooks` (ids of plugin guardrails and run hooks, each `plugin:name`), `costBudget` (`perRunUsd`, `perChatUsd`, and `warnAt` fractions), `toolBudget` (`maxCalls`, `maxDurationSeconds`), `toolApproval` (a tool from `tools` mapped to `never`, `on-changes`, `always` or `blocked`) and `instructions`.',
  );

/**
 * The definition to write, from what the caller sent. Zod types an optional key as possibly
 * `undefined`; the schema never produces one that is present as `undefined`. A `null` list is no
 * list.
 */
function definitionOf(input: z.infer<typeof definitionInputSchema>): AgentFileDefinitionInput {
  const { models, ...rest } = input;
  return { ...rest, ...(models == null ? {} : { models }) } as AgentFileDefinitionInput;
}

const writeResultSchema = z.object({ id: z.string(), hash: z.string() });

/** The reason a file is not an agent, as a wire object. */
function problemView(problem: NonNullable<AgentListing['problem']>) {
  return {
    code: problem.code,
    message: problem.message,
    issues: problem.issues?.map((issue) => ({ ...issue })) ?? null,
  };
}

/**
 * An agent as the wire shows it. `a2a` is whoever opts the agent in saying so: the handler's `a2a`
 * allowlist for a code-defined agent, its own file for a persisted one.
 */
function listingView(host: BureauAgentDefinitionsOperationHost, listing: AgentListing) {
  const a2a =
    listing.source === 'code'
      ? host.agentDefinitions.optsCodeAgentIntoA2A(listing.id)
      : listing.a2a;
  return {
    id: listing.id,
    source: listing.source,
    state: listing.state,
    name: listing.name,
    description: listing.description,
    a2a,
    owner: listing.owner,
    hash: listing.definitionHash ?? null,
    definitionRevision: listing.definitionRevision ?? null,
    problem: listing.problem === undefined ? null : problemView(listing.problem),
    plugin: listing.plugin ?? null,
  };
}

/** A skill descriptor with its readonly arrays copied, so it is the plain data the wire holds. */
function skillView(skill: AgentSkillDescriptor) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: [...skill.tags],
    ...(skill.examples === undefined ? {} : { examples: [...skill.examples] }),
    ...(skill.inputModes === undefined ? {} : { inputModes: [...skill.inputModes] }),
    ...(skill.outputModes === undefined ? {} : { outputModes: [...skill.outputModes] }),
  };
}

function definitionView(definition: AgentFileDefinition) {
  return {
    name: definition.name,
    description: definition.description,
    model: definition.model,
    models: definition.models === undefined ? null : [...definition.models],
    tools: [...definition.tools],
    skillDescriptors: definition.skillDescriptors.map(skillView),
    a2a: definition.a2a,
    stepLimit: definition.stepLimit ?? null,
    retry: definition.retry === undefined ? null : { ...definition.retry },
    compaction: definition.compaction === undefined ? null : { ...definition.compaction },
    references: definition.references === undefined ? null : [...definition.references],
    guardrails: definition.guardrails === undefined ? null : [...definition.guardrails],
    hooks: definition.hooks === undefined ? null : [...definition.hooks],
    toolApproval: definition.toolApproval === undefined ? null : { ...definition.toolApproval },
    toolBudget: definition.toolBudget === undefined ? null : { ...definition.toolBudget },
    costBudget:
      definition.costBudget === undefined
        ? null
        : {
            perRunUsd: definition.costBudget.perRunUsd,
            ...(definition.costBudget.perChatUsd === undefined
              ? {}
              : { perChatUsd: definition.costBudget.perChatUsd }),
            ...(definition.costBudget.warnAt === undefined
              ? {}
              : { warnAt: [...definition.costBudget.warnAt] }),
          },
    instructions: definition.instructions,
  };
}

/** A code agent's definition with its arrays copied, so it is the plain data the wire holds. */
function codeDefinitionView(definition: AgentCodeDefinition) {
  return {
    name: definition.name,
    description: definition.description,
    model: definition.model,
    models: [...definition.models],
    tools: [...definition.tools],
    skills: [...definition.skills],
    skillDescriptors: definition.skillDescriptors.map(skillView),
    instructions: definition.instructions,
  };
}

function detailView(host: BureauAgentDefinitionsOperationHost, detail: AgentFileDetail) {
  return {
    ...listingView(host, detail),
    definition: detail.definition === null ? null : definitionView(detail.definition),
    codeDefinition:
      detail.codeDefinition === undefined ? null : codeDefinitionView(detail.codeDefinition),
    text: detail.text,
  };
}

function mayAccess(
  host: BureauAgentDefinitionsOperationHost,
  principal: Principal,
  operatorScope: BureauScope,
): boolean {
  return mayAccessAgents(host.ownership, principal, operatorScope);
}

/** A caller who may not use `operatorScope` is answered as if the agent were missing. */
function requireAccess(
  host: BureauAgentDefinitionsOperationHost,
  principal: Principal,
  operatorScope: BureauScope,
  identifier: string,
): BureauAgentDefinitionsOperationHost['agentDefinitions'] {
  if (!mayAccess(host, principal, operatorScope)) throw resourceNotFound('agent', identifier);
  return host.agentDefinitions;
}

/**
 * The agents an operation that changes an existing agent may reach. A caller who may not write
 * is answered as if the agent were missing, and so is every caller for a code-defined key: its
 * definition is code, its A2A opt-in is the allowlist's, and no file is read, written, or
 * removed on its behalf, whether or not a same-named file lies in the directory.
 */
function requireWritableAgent(
  host: BureauAgentDefinitionsOperationHost,
  principal: Principal,
  identifier: string,
): BureauAgentDefinitionsOperationHost['agentDefinitions'] {
  const definitions = requireAccess(host, principal, 'bureau.agents:write', identifier);
  const codeDefined = definitions.agents
    .list()
    .some((listing) => listing.id === identifier && listing.source === 'code');
  if (codeDefined) throw resourceNotFound('agent', identifier);
  return definitions;
}

/** A caller who may not use an operation that addresses no existing agent is refused outright. */
function requireScope(
  host: BureauAgentDefinitionsOperationHost,
  principal: Principal,
  operatorScope: BureauScope,
  action: string,
): BureauAgentDefinitionsOperationHost['agentDefinitions'] {
  if (!mayAccess(host, principal, operatorScope)) {
    throw {
      code: 'Forbidden',
      message: `${action} requires ${operatorScope}`,
      data: { reason: `missing scope ${operatorScope}` },
    } satisfies OperationFault;
  }
  return host.agentDefinitions;
}

/**
 * The fault a failed write of an agent file is answered with, or rethrows `error`.
 *
 * Weft's `Conflict` fault carries a `reason` and nothing else, so the hash a stale write needs to
 * retry travels in `StaleRevision`, the fault Weft defines for exactly that.
 */
function faultOf(error: unknown, id: string, expectedHash?: string): never {
  if (error instanceof AgentFileConflictError) {
    if (error.code === 'agent-file-changed' && error.currentHash !== undefined) {
      throw {
        code: 'StaleRevision',
        message: error.message,
        data: {
          ...(expectedHash === undefined ? {} : { expectedRevision: expectedHash }),
          currentRevision: error.currentHash,
        },
      } satisfies OperationFault;
    }
    throw {
      code: 'Conflict',
      message: error.message,
      data: { reason: error.code },
    } satisfies OperationFault;
  }
  if (error instanceof AgentFileError) {
    switch (error.code) {
      case 'agent-file-not-found':
        throw resourceNotFound('agent', id);
      case 'agent-version-not-found':
        throw {
          code: 'NotFound',
          message: error.message,
          data: { resource: 'agent-version', identifier: id },
        } satisfies OperationFault;
      case 'invalid-identifier':
        throw {
          code: 'InvalidParams',
          message: error.message,
          data: { issues: [{ path: ['id'], message: error.message, code: 'custom' }] },
        } satisfies OperationFault;
      case 'agent-directory-not-configured':
        throw {
          code: 'UnsupportedCapability',
          message: 'This Bureau has no agent directory, so its agents cannot be written',
          data: { capability: 'agent-directory' },
        } satisfies OperationFault;
      case 'shadows-code-agent':
        throw {
          code: 'Conflict',
          message: error.message,
          data: { reason: error.code },
        } satisfies OperationFault;
      default:
        throw {
          code: 'Unprocessable',
          message: error.message,
          data: { reason: error.code },
        } satisfies OperationFault;
    }
  }
  throw error;
}

async function audit(
  host: BureauAgentDefinitionsOperationHost,
  principal: Principal,
  type: AgentDefinitionAuditEntry['type'],
  result: { readonly id: string; readonly hash: string },
  previousHash?: string,
): Promise<void> {
  const actor = ownerOfPrincipal(principal);
  await host.agentDefinitions.audit({
    runId: auditTrailAgentOwnerId(result.id),
    type,
    detail: {
      id: result.id,
      hash: result.hash,
      ...(previousHash === undefined ? {} : { previousHash }),
    },
    ...(actor === undefined ? {} : { principal: actor }),
  });
}

const createInput = z.object({ id: agentIdentifier, definition: definitionInputSchema });

export const agentDefinitionsCreateOperation = defineOperation<
  typeof createInput,
  typeof writeResultSchema,
  BureauAgentDefinitionsOperationHost
>({
  name: 'bureau.agents.definitions.create',
  mcpExposable: false,
  summary: 'Create an agent definition',
  description:
    'Writes a new agent file for `id`, the agent’s identifier: a lowercase letter or digit, then lowercase letters, digits, and hyphens, ending in a letter or digit. A caller derives it from the agent’s name; the name is only a label. `definition` is the file’s frontmatter (`name`, `description`, `model` written `<provider>/<model-or-alias>`, `tools`, `skillDescriptors`, `a2a`, `stepLimit`, `retry`, `compaction`, `references`, `guardrails`, `hooks`, `costBudget`, `toolBudget`, `toolApproval`) and its body (`instructions`). A new agent does not opt into A2A unless `a2a` is `true`. The file is written to a temporary file and renamed into place, and the agent is in the catalog before the call returns. Requires `bureau.agents:write` unless the caller owns the deployment’s agents. A taken identifier, including the key of a code-defined agent, is a `Conflict`; a definition that would not load is `Unprocessable`, and nothing is written.',
  destructive: true,
  tags: ['Agents'],
  inputSchema: createInput,
  outputSchema: writeResultSchema,
  producibleFaults: [
    'InvalidParams',
    'Forbidden',
    'Conflict',
    'Unprocessable',
    'UnsupportedCapability',
  ],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const definitions = requireScope(host, principal, 'bureau.agents:write', 'Creating an agent');
    try {
      const result = await definitions.agents.create(input.id, definitionOf(input.definition), {
        savedBy: ownerOfPrincipal(principal),
      });
      await audit(host, principal, 'agent.created', result);
      return result;
    } catch (error) {
      return faultOf(error, input.id);
    }
  },
});

const updateInput = z.object({
  id: agentIdentifier,
  expectedHash: hash,
  definition: definitionInputSchema,
});

export const agentDefinitionsUpdateOperation = defineOperation<
  typeof updateInput,
  typeof writeResultSchema,
  BureauAgentDefinitionsOperationHost
>({
  name: 'bureau.agents.definitions.update',
  mcpExposable: false,
  summary: 'Replace an agent definition',
  description:
    'Replaces the agent file for `id` with `definition`, if it still hashes to `expectedHash` (the `hash` a read returned). Frontmatter keys Bureau does not know stay in the file, and an omitted `a2a`, `stepLimit`, `retry`, `compaction`, `references`, `guardrails`, `hooks`, `costBudget`, `toolBudget` or `toolApproval` keeps the file’s value (`null` removes any but `a2a`). A `definition` that omits `models` removes the file’s list, as omitting `tools` removes its tools. A file that changed since is a `StaleRevision` fault whose `currentRevision` is the hash now on disk, and nothing is written. A definition that changes nothing writes nothing and returns the same hash. A run in progress keeps the definition it started with. Requires `bureau.agents:write` unless the caller owns the deployment’s agents; anyone else is answered `NotFound`, as is an update of a code-defined key, before any file is read.',
  destructive: true,
  tags: ['Agents'],
  inputSchema: updateInput,
  outputSchema: writeResultSchema,
  producibleFaults: [
    'InvalidParams',
    'NotFound',
    'StaleRevision',
    'Unprocessable',
    'UnsupportedCapability',
  ],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const definitions = requireWritableAgent(host, principal, input.id);
    try {
      // An omitted `a2a`, `stepLimit`, `retry`, `compaction`, `references`, `guardrails`, `hooks`, `costBudget`, `toolBudget` or `toolApproval` keeps the file's value: the catalog applies that rule itself.
      const result = await definitions.agents.update(input.id, definitionOf(input.definition), {
        expectedHash: input.expectedHash,
        savedBy: ownerOfPrincipal(principal),
      });
      if (result.hash !== input.expectedHash) {
        await audit(host, principal, 'agent.updated', result, input.expectedHash);
      }
      return result;
    } catch (error) {
      return faultOf(error, input.id, input.expectedHash);
    }
  },
});

const guardedInput = z.object({ id: agentIdentifier, expectedHash: hash });

function defineGuardedWrite(
  name: string,
  summary: string,
  description: string,
  run: (
    agents: BureauAgentDefinitionsOperationHost['agentDefinitions']['agents'],
    id: string,
    expectedHash: string,
  ) => Promise<z.infer<typeof writeResultSchema>>,
  auditType: AgentDefinitionAuditEntry['type'],
) {
  return defineOperation<
    typeof guardedInput,
    typeof writeResultSchema,
    BureauAgentDefinitionsOperationHost
  >({
    name,
    mcpExposable: false,
    summary,
    description,
    destructive: true,
    tags: ['Agents'],
    inputSchema: guardedInput,
    outputSchema: writeResultSchema,
    producibleFaults: [
      'InvalidParams',
      'NotFound',
      'StaleRevision',
      'Unprocessable',
      'UnsupportedCapability',
    ],
    access: { kind: 'authenticated' },
    discoverable: true,
    transports,
    unknownKeyPolicy,
    invoke: async ({ input, host, principal }) => {
      const definitions = requireWritableAgent(host, principal, input.id);
      try {
        const result = await run(definitions.agents, input.id, input.expectedHash);
        await audit(host, principal, auditType, result, input.expectedHash);
        return result;
      } catch (error) {
        return faultOf(error, input.id, input.expectedHash);
      }
    },
  });
}

export const agentDefinitionsDeleteOperation = defineGuardedWrite(
  'bureau.agents.definitions.delete',
  'Delete an agent definition',
  'Deletes the agent’s file, if it still hashes to `expectedHash`, which removes the agent. A run keeps the definition it started on: the snapshots of runs that are still retained stay, and `bureau.agents.definitions.revisions` still lists them. A run waiting for an answer can still be resumed after the delete. Deleting a code-defined agent’s key is answered `NotFound` before any file is read, whether or not a same-named file exists. Requires `bureau.agents:write` unless the caller owns the deployment’s agents.',
  (agents, id, expectedHash) => agents.delete(id, { expectedHash }),
  'agent.deleted',
);

const getInput = z.object({ id: agentIdentifier });

export const agentDefinitionsGetOperation = defineOperation<
  typeof getInput,
  typeof agentDetailSchema,
  BureauAgentDefinitionsOperationHost
>({
  name: 'bureau.agents.definitions.get',
  mcpExposable: false,
  summary: 'Read one agent definition',
  description:
    'Returns one agent: whether it is `ready` or `invalid` (with the `problem` that makes it so), whether it opts into A2A (`a2a`: the handler’s `a2a` allowlist for a code-defined agent, its own file for a persisted one; an invalid file never opts in, even when its `a2a` key says so), its `definitionRevision` (`null` for an invalid file), and, for a file, its `hash`, exact `text`, and parsed `definition`. An editor writes a change back with `expectedHash` set to `hash`. A code-defined agent has `source: "code"`, no hash, no `text`, and no `definition`; its `codeDefinition` is what the agent states about itself, read-only: its `instructions`, its `model` (`<provider>/<model>`, `null` for a scripted or routed agent) and the `models` a session may switch to, its `tools` and executable `skills` by name, and its `skillDescriptors`. A file agent has `codeDefinition: null`. Requires `bureau.agents:read` unless the caller owns the deployment’s agents; anyone else is answered `NotFound`.',
  destructive: false,
  tags: ['Agents'],
  inputSchema: getInput,
  outputSchema: agentDetailSchema,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const definitions = requireAccess(host, principal, 'bureau.agents:read', input.id);
    const detail = await definitions.agents.detail(input.id);
    if (detail === undefined) throw resourceNotFound('agent', input.id);
    return detailView(host, detail);
  },
});

const listInput = z.object({ ...pageFields });
const listOutput = z.object({
  agents: z.array(agentListingSchema),
  nextOffset: z.number().int().nullable(),
});

export const agentDefinitionsListOperation = defineOperation<
  typeof listInput,
  typeof listOutput,
  BureauAgentDefinitionsOperationHost
>({
  name: 'bureau.agents.definitions.list',
  mcpExposable: false,
  summary: 'List agent definitions',
  description:
    'Lists every agent: the code-defined ones in definition order, then the agent files by identifier, `ready` and `invalid` alike. Each file shows its `hash`, `state`, and `definitionRevision`. Pages with `limit` (1 to 100, default 50) and `offset`; `nextOffset` is `null` on the last page. A caller who does not own the deployment’s agents and lacks `bureau.agents:read` gets an empty page.',
  destructive: false,
  tags: ['Agents'],
  inputSchema: listInput,
  outputSchema: listOutput,
  producibleFaults: ['InvalidParams'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    if (!mayAccess(host, principal, 'bureau.agents:read')) {
      return { agents: [], nextOffset: null };
    }
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const offset = input.offset ?? 0;
    const all = host.agentDefinitions.agents.list();
    return {
      agents: all.slice(offset, offset + limit).map((listing) => listingView(host, listing)),
      nextOffset: all.length > offset + limit ? offset + limit : null,
    };
  },
});

const revisionsOutput = z.object({
  revisions: z.array(
    z.object({
      hash: z.string(),
      firstRunAt: z.string(),
      lastRunAt: z.string(),
      definition: definitionOutputSchema,
    }),
  ),
});

export const agentDefinitionsRevisionsOperation = defineOperation<
  typeof getInput,
  typeof revisionsOutput,
  BureauAgentDefinitionsOperationHost
>({
  name: 'bureau.agents.definitions.revisions',
  mcpExposable: false,
  summary: 'List the revisions of an agent that have run (not the saved versions)',
  description:
    'Lists the snapshots of the agent’s definition that have run, most recently run first, each with the definition it ran. A snapshot is kept while any run that references it is retained, so a deleted agent still lists the revisions of its retained runs, and a revision that was saved but never ran is not listed. A code-defined agent has none. This is the history of the runs; `bureau.agents.versions.list` is the history of the saves, which includes a version that never ran. Requires `bureau.agents:read` unless the caller owns the deployment’s agents; anyone else, and an identifier with neither an agent nor a retained revision, is answered `NotFound`.',
  destructive: false,
  tags: ['Agents'],
  inputSchema: getInput,
  outputSchema: revisionsOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const definitions = requireAccess(host, principal, 'bureau.agents:read', input.id);
    const revisions = await definitions.agents.revisions(input.id);
    if (revisions.length === 0) {
      const known = definitions.agents.list().some((listing) => listing.id === input.id);
      if (!known) throw resourceNotFound('agent', input.id);
    }
    return {
      revisions: revisions.map((revision) => ({
        hash: revision.hash,
        firstRunAt: revision.firstRunAt,
        lastRunAt: revision.lastRunAt,
        definition: definitionView(revision.definition),
      })),
    };
  },
});

const versionSchema = z.object({
  revision: z.number().int().positive(),
  hash: z.string(),
  savedAt: z.string(),
  /** Who saved it through these operations, or `null` for an edit made to the file directly. */
  savedBy: z.string().nullable(),
  owner: z.string(),
  definition: definitionOutputSchema,
  /**
   * The path and SHA-256 of each reference document as it was read when the version was saved;
   * `null` for an agent with no references. A version never holds a document's text.
   */
  referenceDigests: z.array(z.object({ path: z.string(), digest: z.string() })).nullable(),
  /** The definition keys that differ from the previous version's, such as `["instructions"]`. */
  changedKeys: z.array(z.string()),
});

const versionsListOutput = z.object({ versions: z.array(versionSchema) });

export const agentVersionsListOperation = defineOperation<
  typeof getInput,
  typeof versionsListOutput,
  BureauAgentDefinitionsOperationHost
>({
  name: 'bureau.agents.versions.list',
  mcpExposable: false,
  summary: 'List the saved versions of an agent',
  description:
    'Lists the versions of the agent’s definition, newest first, each with its `revision`, the `hash` it was saved at (the file’s hash, or for an agent with references the identity hash described below, which is not the `expectedHash` a write takes), when it was saved (`savedAt`), who saved it (`savedBy`, or `null` for an edit made to the file directly), the whole `definition`, the `referenceDigests` of the reference documents it read (`null` without references; for an agent that has them `hash` is the identity hash that folds the digests in, and an edit to a document alone gives `changedKeys` `["references"]`), and the `changedKeys` that differ from the version before it (a change to the instructions alone gives `["instructions"]`). Every save and every direct edit is one version, whether or not the agent ran, and a version outlives the runs that used it. Bureau keeps the newest 50 and any older version a retained run still references. A code-defined agent has none. `bureau.agents.definitions.revisions` is the history of the runs, not of the saves. Requires `bureau.agents:read` unless the caller owns the deployment’s agents; anyone else, and an identifier with neither an agent nor a stored version, is answered `NotFound`; a deleted agent still lists the versions it kept.',
  destructive: false,
  tags: ['Agents'],
  inputSchema: getInput,
  outputSchema: versionsListOutput,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const definitions = requireAccess(host, principal, 'bureau.agents:read', input.id);
    const known = definitions.agents.list().some((listing) => listing.id === input.id);
    const versions = await definitions.agents.versions.list(input.id);
    if (versions.length === 0 && !known) throw resourceNotFound('agent', input.id);
    return {
      versions: versions.map((version) => ({
        revision: version.revision,
        hash: version.hash,
        savedAt: version.savedAt,
        savedBy: version.savedBy,
        owner: version.owner,
        definition: definitionView(version.definition),
        referenceDigests: version.referenceDigests?.map((digest) => ({ ...digest })) ?? null,
        changedKeys: [...version.changedKeys],
      })),
    };
  },
});

const restoreInput = z.object({
  id: agentIdentifier,
  revision: z.number().int().positive().describe('The `revision` of the version to restore.'),
  expectedHash: hash,
});
const restoreOutput = writeResultSchema.extend({
  /** The definition revision the file is at now; `null` if the catalog does not list it. */
  revision: z.number().int().positive().nullable(),
});

export const agentVersionsRestoreOperation = defineOperation<
  typeof restoreInput,
  typeof restoreOutput,
  BureauAgentDefinitionsOperationHost
>({
  name: 'bureau.agents.versions.restore',
  mcpExposable: false,
  summary: 'Restore a saved version of an agent',
  description:
    'Writes the definition of version `revision` back to the agent’s file as a new revision, if the file still hashes to `expectedHash`, and returns the new `hash` and `revision`. The restore is itself a save, so it appends a new version equal in content to the one restored and leaves the older versions as they were. `expectedHash` is the hash of the file’s bytes as `bureau.agents.definitions.get` returns it (`hash`), never the `hash` of a version from `versions.list`, which for an agent with references is an identity hash that also folds in the reference documents; sending it is a `StaleRevision` fault. The definition’s `references` list is restored, but the documents are not: they are whatever those paths name when the file is read again (the version’s `referenceDigests` say what they were), and `examples` are not restored either; the file keeps what it has. A file that moved since is a `StaleRevision` fault whose `currentRevision` is the hash now on disk; a definition that no longer resolves (its model or a tool is gone from the deployment, a reference document is missing or too large (`missing-reference`, `reference-too-large`), a guardrail or run hook it lists is no longer contributed (`reference-unresolved`), or it enables compaction with no summarizer) is `Unprocessable`; an unknown version is `NotFound`; each writes nothing. Restoring the definition the file already has writes nothing and returns the same hash. Requires `bureau.agents:write` unless the caller owns the deployment’s agents; anyone else is answered `NotFound`.',
  destructive: true,
  tags: ['Agents'],
  inputSchema: restoreInput,
  outputSchema: restoreOutput,
  producibleFaults: [
    'InvalidParams',
    'NotFound',
    'StaleRevision',
    'Unprocessable',
    'UnsupportedCapability',
  ],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const definitions = requireWritableAgent(host, principal, input.id);
    try {
      const result = await definitions.agents.versions.restore(input.id, input.revision, {
        expectedHash: input.expectedHash,
        savedBy: ownerOfPrincipal(principal),
      });
      // Read before the audit write is awaited, so a save that settles during it is not reported
      // as this restore's revision.
      const listing = definitions.agents.list().find((candidate) => candidate.id === input.id);
      if (result.hash !== input.expectedHash) {
        await audit(host, principal, 'agent.updated', result, input.expectedHash);
      }
      return { ...result, revision: listing?.definitionRevision ?? null };
    } catch (error) {
      return faultOf(error, input.id, input.expectedHash);
    }
  },
});

const modalitySupportSchema = z.object({
  input: z.boolean(),
  output: z.boolean(),
  sourceForms: z.array(z.string()),
});

/**
 * A model as `projectDescriptor(descriptor, 'general')` leaves it. Every key of the descriptor
 * that the projection keeps is declared, and the schema strips any other, so a key the projection
 * withholds (`pricing`, `endpointAmbiguous`) cannot reach the wire even by a mistake upstream.
 */
const modelSchema = z.object({
  descriptorVersion: z.number(),
  provider: z.string(),
  endpoint: z.string(),
  model: z.string(),
  aliases: z.array(z.object({ alias: z.string(), resolvesTo: z.string() })),
  lifecycle: z.enum(['preview', 'stable', 'deprecated', 'retired']),
  modalities: z.record(z.string(), modalitySupportSchema),
  mimeFamilies: z.array(z.string()),
  mediaLimits: z.array(z.json()),
  mediaCounts: z.array(z.object({ modality: z.string(), maxPerRequest: z.number() })),
  providerFetchesRemoteUrls: z.boolean(),
  toolResultModalities: z.array(z.string()).optional(),
  generatedAssetBehavior: z.array(z.json()).optional(),
  contextWindowTokens: z.number(),
  maxOutputTokens: z.number(),
  streaming: z.boolean(),
  tools: z.boolean(),
  parallelTools: z.boolean(),
  structuredOutput: z.boolean(),
  parameterCompatibility: z.array(z.string()),
  caching: z.boolean(),
  batchInference: z.boolean(),
  explicitThinkingRequest: z.boolean(),
  serverSideTokenCounting: z.boolean(),
  effort: z.object({
    portable: z.array(z.string()),
    nativeMapping: z.string(),
    degradesTo: z.record(z.string(), z.string().optional()),
  }),
  availability: z.enum(['available', 'unavailable', 'unknown']),
  health: z.enum(['healthy', 'degraded', 'unhealthy', 'unknown']),
  source: z.enum(['static', 'provider-reported', 'operator-override']),
  freshness: z.string(),
});

/**
 * The general projection of a catalog row, copied out of its frozen form. `modelSchema` declares
 * every key the projection keeps; a test compares the two.
 */
function modelView(descriptor: BackendDescriptor): z.infer<typeof modelSchema> {
  return structuredClone(projectDescriptor(descriptor, 'general')) as unknown as z.infer<
    typeof modelSchema
  >;
}

const catalogInput = z.object({});
const catalogOutput = z.object({
  models: z.array(modelSchema),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      /** The one line a screen shows for the tool, or `null` when it declares none. */
      shortDescription: z.string().nullable(),
      /** What the tool takes, as a JSON Schema; `null` when its schema cannot be written as one. */
      inputSchema: z.record(z.string(), z.unknown()).nullable(),
      /** What the tool may technically do; `null` when it declares none, which is never read as read-only. */
      tier: z.enum(['read-only', 'mutating', 'dangerous']).nullable(),
      /** What happens by default when an agent calls the tool: the `on-changes` rule applied to the tier. */
      defaultApproval: z.enum(['allow', 'ask']),
      /** `bureau` for a tool Bureau adds itself, `host` for one the host passed in. */
      source: z.enum(['host', 'bureau']),
      /** The agents that use the tool now: ready agent files that list it, and code agents that name it. */
      users: z.array(z.string()),
    }),
  ),
});

export const agentsCatalogOperation = defineOperation<
  typeof catalogInput,
  typeof catalogOutput,
  BureauAgentDefinitionsOperationHost
>({
  name: 'bureau.agents.catalog',
  mcpExposable: false,
  summary: 'List the models and tools an agent may name',
  description:
    'Returns the deployment’s selectable `models`, the rows of its model catalog unfiltered and each reduced to the `general` audience whoever asks (pricing and `endpointAmbiguous` are never returned), and its `tools`, by the name an agent file lists them under, each with its model-facing `description`, a `shortDescription` (one line for a person, or `null` when the tool declares none), its `inputSchema` (JSON Schema, or `null`), its capability `tier` (`read-only`, `mutating` or `dangerous`; `null` when it declares none), its `defaultApproval` (`allow` for a read-only tool, `ask` for a tool that changes something, is dangerous or is unclassified: the `on-changes` rule a file agent’s tool follows when its `toolApproval` says nothing (COR-1913), applied to the tier; a file’s own `toolApproval` entry replaces it for that agent), its `source` (`bureau` for the settings and workflow tools Bureau adds, `host` for tools the host provides) and its `users`, the identifiers of the agents that use it now. A definition’s `model` is written `<provider>/<model-or-alias>` and its `tools` are names from this list. Requires `bureau.agents:read` unless the caller owns the deployment’s agents; anyone else is refused with `Forbidden`.',
  destructive: false,
  tags: ['Agents'],
  inputSchema: catalogInput,
  outputSchema: catalogOutput,
  producibleFaults: ['InvalidParams', 'Forbidden'],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: ({ host, principal }) => {
    const definitions = requireScope(
      host,
      principal,
      'bureau.agents:read',
      'Reading the agent catalog',
    );
    return Promise.resolve({
      // The general projection is applied for every caller, so no caller sees a price.
      models: definitions.models().map(modelView),
      tools: definitions.agents.tools().map((tool) => ({
        ...tool,
        inputSchema: tool.inputSchema === null ? null : structuredClone(tool.inputSchema),
        users: [...tool.users],
      })),
    });
  },
});

const tryInput = z.object({
  definition: definitionInputSchema,
  message: z
    .string()
    .min(1)
    .describe('The first message of the throwaway chat, which the tried agent answers.'),
});

const tryOutput = z.object({
  contextId: z.string().describe('The new context, whose origin is `try`.'),
  agentName: z
    .string()
    .describe('The name the tried agent runs under: valid only for `contextId`, in no catalog.'),
  taskId: z.string().describe('The task that answers the first message.'),
});

/**
 * The fault for a definition that was refused or could not be tried, as `create` answers one:
 * `Unprocessable`, whose message names each field at fault (`model`, `tools.1`).
 */
function tryFaultOf(error: unknown): never {
  if (error instanceof AgentFileError) {
    if (error.code === 'agent-directory-not-configured') {
      throw {
        code: 'UnsupportedCapability',
        message: error.message,
        data: { capability: 'agent-directory' },
      } satisfies OperationFault;
    }
    throw {
      code: 'Unprocessable',
      message: error.message,
      data: { reason: error.code },
    } satisfies OperationFault;
  }
  if (error instanceof BureauError && error.code === 'CONFLICT') {
    throw {
      code: 'Unavailable',
      message: error.message,
      data: { reason: 'shutting-down' },
    } satisfies OperationFault;
  }
  throw error;
}

export const agentsTryOperation = defineOperation<
  typeof tryInput,
  typeof tryOutput,
  BureauAgentDefinitionsOperationHost
>({
  name: 'bureau.agents.try',
  mcpExposable: false,
  summary: 'Try an unsaved agent definition',
  description:
    'Builds an agent from `definition` with the schema and checks of an agent file, writes nothing, and starts a new throwaway context with it over `message`. The result is the `contextId` (its `origin` is `try`), the `agentName` the agent runs under (it starts with `try:`, is in no catalog and is valid only for that context) and the `taskId` that answers the first message; follow up with a task on that context and agent. A definition that would not load as a file is `Unprocessable`, as for `create`, its message naming each field at fault (`model`, `tools.1`), and nothing exists. A definition that lists `references`, or a tool that writes memory, schedules work or delegates (`memory_store`, `memory_forget`, `scheduleSelf`, `scheduleWakeup`, `bureau:workflows-create`, `bureau:workflows-update`, `bureau:workflows-pause`, `bureau:workflows-resume`, `settings-update`, `transfer_to_*`), is refused the same way. A run of the tried agent remembers nothing, is offered neither `scheduleWakeup` nor `decide`, and cannot start a child. The agent lives in memory for the context: `bureau.contexts.delete` removes the context and the agent together, and a restart ends the agent, leaving a context that can be read and deleted. The context is left out of `bureau.contexts.list` unless `origin` is `try`, and its tasks out of `bureau.tasks.list` unless it is filtered by `contextId` or `agentName`. Requires `bureau.agents:write` unless the caller owns the deployment’s agents; anyone else is refused with `Forbidden`.',
  destructive: true,
  tags: ['Agents'],
  inputSchema: tryInput,
  outputSchema: tryOutput,
  producibleFaults: [
    'InvalidParams',
    'Forbidden',
    'Unprocessable',
    'UnsupportedCapability',
    'Unavailable',
  ],
  access: { kind: 'authenticated' },
  discoverable: true,
  transports,
  unknownKeyPolicy,
  invoke: async ({ input, host, principal }) => {
    const definitions = requireScope(
      host,
      principal,
      'bureau.agents:write',
      'Trying an agent definition',
    );
    const owner = ownerOfPrincipal(principal);
    try {
      return await definitions.agents.try(
        definitionOf(input.definition),
        input.message,
        owner === undefined ? {} : { principal: owner },
      );
    } catch (error) {
      return tryFaultOf(error);
    }
  },
});

/** The agent definition operations, in the order the handler serves them. */
export const bureauAgentDefinitionsOperations = [
  agentDefinitionsCreateOperation,
  agentDefinitionsUpdateOperation,
  agentDefinitionsDeleteOperation,
  agentDefinitionsGetOperation,
  agentDefinitionsListOperation,
  agentDefinitionsRevisionsOperation,
  agentsCatalogOperation,
  agentVersionsListOperation,
  agentVersionsRestoreOperation,
  agentsTryOperation,
] as const;
