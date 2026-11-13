/**
 * The browser's view of the Bureau's agent definitions: the operations `bureau.agents.definitions.*`
 * and `bureau.agents.catalog` (COR-1526), parsed at the boundary, and the faults a write can answer
 * with, sorted into the few the editor tells apart.
 *
 * An agent is a Markdown file, and its identifier is the filename without `.md`. Every write names
 * the `hash` of the file the caller read, so a file that changed since is refused instead of
 * overwritten. `a2a` (whether the agent opts into A2A) is part of the definition a save sends.
 */
import { HttpClientError } from '@lostgradient/weft';
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

/**
 * What an agent's identifier must look like, and the longest it may be. The Bureau owns both rules
 * (`AGENT_FILE_STEM_PATTERN` and `AGENT_IDENTIFIER_MAX_LENGTH` in its `agent-file.ts`; an owner's file never carries a plugin's `plugin:name`); the
 * browser cannot import that module, so the editor repeats them to answer while the person types,
 * and `src/host/host-agent-definitions.test.ts` fails if the two drift apart. The Bureau still
 * refuses an identifier that breaks them.
 */
export const AGENT_IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/** The longest an agent identifier may be, in characters. */
export const AGENT_IDENTIFIER_MAX_LENGTH = 64;

/**
 * The most steps a run takes when its agent sets no limit: Operative's `DEFAULT_MAXIMUM_STEPS`,
 * which the browser cannot import. `src/host/host-agent-definitions.test.ts` fails if the two
 * drift apart.
 */
export const DEFAULT_STEP_LIMIT = 25;

/**
 * The agent's `card` entry. The editor never edits one, but a save sends them back unchanged, so
 * a key this page does not know is kept as it was read and never stripped.
 */
const skillSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  examples: z.array(z.string()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
});

/** An agent definition's `card` entry, as the Bureau reads it back. */
export type AgentSkill = z.infer<typeof skillSchema>;

/** When a tool asks a person before it runs (`approvals` in an agent file). A tool the file leaves out is `on-changes`. */
export const TOOL_APPROVALS = ['never', 'on-changes', 'always', 'blocked'] as const;

/** One of the four answers to "when does this tool ask first?". */
export type ToolApproval = (typeof TOOL_APPROVALS)[number];

/**
 * The reasoning efforts an agent file may start a chat at (`effort`), from least to most:
 * the Bureau's `agentDefaultEffortSchema`, which the browser cannot import.
 * `src/host/host-agent-definitions.test.ts` fails if the two drift apart.
 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** One of the efforts an agent file may name. */
export type Effort = (typeof EFFORTS)[number];

/**
 * One entry of a definition's `guardrails` (COR-2118): a guardrail's id, `plugin:name`, or the id
 * with the configuration the agent gives it.
 */
const guardrailEntrySchema = z.union([
  z.string(),
  z.object({ id: z.string(), configuration: z.record(z.string(), z.unknown()) }),
]);

/** An entry of a definition's `guardrails`: an id, or an id with its configuration. */
export type AgentGuardrailEntry = z.infer<typeof guardrailEntrySchema>;

/** The guardrail an entry names, whichever form it is written in. */
export function guardrailEntryId(entry: AgentGuardrailEntry): string {
  return typeof entry === 'string' ? entry : entry.id;
}

/**
 * The entries to save for the guardrail ids a form holds: each id an entry of `kept` configures
 * keeps that entry, so a form that edits ids alone never drops a configuration it does not show.
 */
export function guardrailEntriesFor(
  ids: readonly string[],
  kept: readonly AgentGuardrailEntry[] | null | undefined,
): AgentGuardrailEntry[] {
  const configured = new Map(
    (kept ?? []).flatMap((entry) =>
      typeof entry === 'string' ? [] : [[entry.id, entry] as const],
    ),
  );
  return ids.map((id) => configured.get(id) ?? id);
}

const definitionSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  model: z.string(),
  /**
   * The models a session of the agent may be switched to (COR-1559), or `null` when the file lists
   * none. The editor never edits it, but a save sends it back unchanged, as it does `card`: an
   * update that omits it removes the list.
   */
  models: z.array(z.string()).nullable().default(null),
  /**
   * The reasoning effort a chat of the agent starts at (COR-1961), or `null` when the file sets none
   * and the provider's own default applies. The default model must support it.
   */
  effort: z.enum(EFFORTS).nullable().default(null),
  tools: z.array(z.string()),
  card: z.array(skillSchema),
  /** The executable skills a run may activate; `null` when the file lists none, and the agent has none. */
  skills: z.array(z.string()).nullable().default(null),
  children: z.array(z.string()).nullable().optional(),
  a2a: z.boolean(),
  /**
   * What a run may take, spend and use: `steps`, the most steps one run may take; `cost`, what the
   * agent may spend in US dollars (`run`, `chat`, and `warn`, fractions of `run`); `tools`, what one
   * run's tools may use (`calls`, `seconds`). Each is `null` when the file sets none.
   */
  limits: z
    .object({
      steps: z.number().int().nullable().default(null),
      cost: z
        .object({
          run: z.number(),
          chat: z.number().optional(),
          /** The fractions of `run` at which a run warns. The editor never edits them; a save sends them back. */
          warn: z.array(z.number()).optional(),
        })
        .nullable()
        .default(null),
      tools: z
        .object({ calls: z.number().optional(), seconds: z.number().optional() })
        .nullable()
        .default(null),
    })
    .default({ steps: null, cost: null, tools: null }),
  /**
   * How a run retries a failed generate call (`attempts`, `delayMilliseconds`, `jitter`); `null`
   * when the file sets none. The editor never edits it: a save sends it back, and a copy keeps it.
   */
  retry: z.looseObject({ attempts: z.number() }).nullable().default(null),
  /** Whether and when a run compacts its conversation; `null` when the file sets none. Carried like `retry`. */
  compaction: z.looseObject({ enabled: z.boolean() }).nullable().default(null),
  /** The plugin interceptors (`plugin:name`) the file lists; `null` when it lists none. Carried like `retry`. */
  interceptors: z.array(z.string()).nullable().default(null),
  /** The reference documents, as paths beside the file; `null` when the file lists none. */
  references: z.array(z.string()).nullable().default(null),
  /**
   * The plugin guardrails the file lists besides the default preset, each `plugin:name` or
   * `{ id, configuration }` (COR-2118); `null` when it lists none.
   */
  guardrails: z.array(guardrailEntrySchema).nullable().default(null),
  /**
   * When each listed tool asks first, by tool name; `null` when the file sets none. A tool the
   * map leaves out is `on-changes`. Every key is one of `tools`.
   */
  approvals: z.record(z.string(), z.enum(TOOL_APPROVALS)).nullable().default(null),
  instructions: z.string(),
});

/** The definition of a file agent, as `bureau.agents.definitions.get` shows it. */
type AgentDefinition = z.infer<typeof definitionSchema>;

/** The limits an update sends: a limit left out keeps the file's, and `null` removes it. */
export interface AgentLimitsInput {
  /** The most steps one run may take, in whole steps. */
  readonly steps?: number | null;
  /** What the agent may spend, in US dollars: `run`, `chat`, and `warn` as fractions of `run`. */
  readonly cost?: {
    readonly run: number;
    readonly chat?: number;
    readonly warn?: readonly number[];
  } | null;
  /** What one run's tools may use: a count of `calls`, and `seconds` of running. */
  readonly tools?: {
    readonly calls?: number;
    readonly seconds?: number;
  } | null;
}

const problemSchema = z.object({
  code: z.string(),
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).nullable(),
});

/**
 * A problem the Bureau found in an agent definition: a code, a message, and the field-level issues
 * behind it when there are any.
 */
export type AgentProblem = z.infer<typeof problemSchema>;

/**
 * Why an `unavailable` agent cannot run (COR-2009): its plugin is disabled, as in `Plugin Demo is
 * disabled`. A stub that predates the key reads as available.
 */
const unavailableSchema = z
  .object({ code: z.literal('plugin-disabled'), message: z.string() })
  .nullable()
  .default(null);

const detailSchema = z.object({
  id: z.string(),
  source: z.enum(['code', 'file']),
  /** `unavailable` is a code agent of a disabled plugin: it can be read and duplicated, never run. */
  state: z.enum(['ready', 'invalid', 'unavailable']),
  unavailable: unavailableSchema,
  name: z.string(),
  description: z.string().nullable(),
  a2a: z.boolean(),
  hash: z.string().nullable(),
  problem: problemSchema.nullable(),
  definition: definitionSchema.nullable(),
  /** What a code-defined agent states about itself, read-only (COR-1818); `null` for a file agent. */
  codeDefinition: z
    .object({
      name: z.string(),
      description: z.string().nullable(),
      /** `<provider>/<model>`, or `null` for a scripted or routed agent. */
      model: z.string().nullable(),
      models: z.array(z.string()),
      tools: z.array(z.string()),
      /** The executable skills the agent can activate, by name. */
      skills: z.array(z.string()),
      card: z.array(skillSchema),
      instructions: z.string().nullable(),
    })
    .nullable()
    // The Bureau always sends it. A stub that predates the key reads as a file agent.
    .default(null),
  /**
   * The size in bytes of each reference document a ready file agent read, in the order its
   * `references` lists them (COR-2020), for lines such as "Refund policy.md 4 KB"; `null` for a
   * code agent, a file with no references, and a file that is not ready.
   */
  referenceSizes: z
    .array(z.object({ path: z.string(), size: z.number() }))
    .nullable()
    // A stub that predates the key reads as an agent whose sizes are not known.
    .default(null),
});

/** One agent as `bureau.agents.definitions.get` shows it. */
export type AgentDetail = z.infer<typeof detailSchema>;

const revisionsSchema = z.object({
  revisions: z.array(z.object({ hash: z.string(), firstRunAt: z.string(), lastRunAt: z.string() })),
});

/** A version of the agent's definition that has run. */
export type AgentRevision = z.infer<typeof revisionsSchema>['revisions'][number];

const versionsSchema = z.object({
  versions: z.array(
    z.object({
      revision: z.number().int(),
      hash: z.string(),
      savedAt: z.string(),
      savedBy: z.string().nullable(),
      /** The definition a file agent's version holds; `null` for a built-in agent's, which holds overrides (COR-2009). */
      definition: definitionSchema.nullable(),
      changedKeys: z.array(z.string()),
    }),
  ),
});

/** A saved version of an agent's definition, as `bureau.agents.versions.list` shows it. */
export type AgentVersion = z.infer<typeof versionsSchema>['versions'][number];

/**
 * A model of `bureau.agents.catalog`: the keys of the catalog row (`modelSchema` in Bureau's
 * `agent-definitions-operations.ts`, the `general` projection) that the editor reads. The Bureau
 * returns every row unfiltered, with the abilities each declares, so a model that is turned off
 * (`availability: 'unavailable'`) or retired is still listed and the editor says why it is not
 * offered. A key this schema does not name is stripped, and a price is never on the wire.
 *
 * The catalog holds rows only for providers the host can call, so a provider with no API key has
 * none: the providers that are not connected come from the host (`/host/providers`,
 * `host-providers.ts`), which owns the keys, and the editor lays the two side by side.
 */
const catalogModelSchema = z.object({
  provider: z.string(),
  model: z.string(),
  aliases: z.array(z.object({ alias: z.string(), resolvesTo: z.string() })),
  /** Where the row is in its life; the Bureau refuses an agent file whose model is `retired`. */
  lifecycle: z.enum(['preview', 'stable', 'deprecated', 'retired']),
  /** `unavailable` is a row turned off in Settings › Models, which agents and plans do not use. */
  availability: z.enum(['available', 'unavailable', 'unknown']),
  /** The model's context window, in tokens. */
  contextWindowTokens: z.number(),
  /** The most tokens one answer may hold. */
  maxOutputTokens: z.number(),
  /** Whether the model streams its answer. */
  streaming: z.boolean(),
  /** Whether the model can call tools. */
  tools: z.boolean(),
  /** Whether the model can answer to a schema. */
  structuredOutput: z.boolean(),
  /** What the model takes and gives, by modality (`text`, `image`, ...): only `input` is read. */
  modalities: z.record(z.string(), z.object({ input: z.boolean() })),
  /**
   * The efforts the model supports: `portable` is the tiers an agent file's `effort` may
   * name, and the Bureau refuses a save that names another (`effort-not-supported`). It is empty
   * for a model with no effort control.
   */
  effort: z.object({ portable: z.array(z.string()) }),
});

/** One model of the catalog, with the abilities and standing the Bureau reports for it. */
export type CatalogModel = z.infer<typeof catalogModelSchema>;

const catalogSchema = z.object({
  models: z.array(catalogModelSchema),
  tools: z.array(
    z.object({
      name: z.string(),
      /** What the model is told about the tool: a prompt, which can run to several paragraphs. */
      description: z.string(),
      /** The one line a person is shown for the tool, or `null` when the tool declares none. */
      shortDescription: z.string().nullable(),
      /** The tool's name for a person ("Issue refund"), or `null` when it has none or the Bureau sends none. */
      title: z.string().nullable().default(null),
      /** What the tool takes, as a JSON Schema, or `null` when it cannot be written as one. */
      inputSchema: z.record(z.string(), z.unknown()).nullable(),
      /** What the tool may technically do, or `null` when it declares none. */
      tier: z.enum(['read-only', 'mutating', 'dangerous']).nullable(),
      /** What happens by default when an agent calls the tool (Armorer's tier rule). */
      defaultApproval: z.enum(['allow', 'ask']),
      /** `skill` for a tool a skill brings, else `bureau` for a tool Bureau adds, `plugin` for one a plugin contributes, `host` for one the host provides (an MCP server's). */
      source: z.enum(['host', 'bureau', 'plugin', 'skill']),
      /** The plugin that contributes the tool (`source` is `plugin`, or `skill` for a plugin's skill), else `null`. */
      plugin: z.string().nullable(),
      /** The skill that brings the tool when `source` is `skill`, else `null` (also when the Bureau sends none). */
      skill: z.string().nullable().default(null),
      /** The agents that use the tool now. */
      users: z.array(z.string()),
    }),
  ),
});

/** The models and tools an agent may name, as `bureau.agents.catalog` lists them. */
export type AgentCatalog = z.infer<typeof catalogSchema>;

const writeResultSchema = z.object({ id: z.string(), hash: z.string() });

/** What a write answers: the agent's identifier and the hash of the file now on disk. */
export type AgentWriteResult = z.infer<typeof writeResultSchema>;

/**
 * What a caller supplies to create or update an agent. An optional key is left out, never sent as
 * `undefined`.
 */
export type AgentDefinitionInput = {
  readonly name?: string;
  readonly description: string | null;
  readonly model: string;
  /**
   * The models a session may be switched to. Left out (or `null`), an update removes the list, as
   * it does `tools`.
   */
  readonly models?: readonly string[] | null;
  /**
   * The reasoning effort a chat of the agent starts at, which the default `model` must support.
   * `null` removes it; left out, an update keeps the file's.
   */
  readonly effort?: Effort | null;
  readonly tools: readonly string[];
  /** Carried through a save unchanged: the editor shows no control for them. */
  readonly card: readonly AgentSkill[];
  /**
   * The executable skills a run may activate. An update that leaves it out keeps the file's list,
   * `null` removes it, and an empty list grants none.
   */
  readonly skills?: readonly string[] | null;
  /** File agents this definition may dispatch as durable children. */
  readonly children?: readonly string[] | null;
  /** Whether the agent opts into A2A. Left out, an update keeps the file's value. */
  readonly a2a?: boolean;
  /**
   * What a run may take, spend and use. `null` removes every limit; left out, an update keeps the
   * file's. Inside it, a limit left out keeps the file's and `null` removes it.
   */
  readonly limits?: AgentLimitsInput | null;
  /**
   * The plugin guardrails, each `plugin:name` or `{ id, configuration }`. `null` removes them; left
   * out, an update keeps the file's.
   */
  readonly guardrails?: readonly AgentGuardrailEntry[] | null;
  /**
   * How a run retries a failed generate call. The editor shows no control for it: a save carries it
   * through and a copy keeps it. Left out, an update keeps the file's.
   */
  readonly retry?: AgentDefinition['retry'];
  /** Whether and when a run compacts its conversation; carried like `retry`. */
  readonly compaction?: AgentDefinition['compaction'];
  /** The plugin interceptors (`plugin:name`); carried like `retry`. */
  readonly interceptors?: readonly string[] | null;
  /**
   * When each tool asks first. `null` removes the map; left out, an update keeps the file's. A
   * key must be one of `tools`, or the Bureau refuses the write.
   */
  readonly approvals?: Readonly<Record<string, ToolApproval>> | null;
  /**
   * Documents beside the agent's file that its instructions are read with. A create sends it (a
   * copy of an agent that has them), and an update sends it to take documents off the list (the
   * Edit form, row 41t); left out, an update keeps the file's, and `null` removes the list.
   */
  readonly references?: readonly string[] | null;
  readonly instructions: string;
};

/** Where a call is sent from: an abort signal, and a `fetch` for a caller that is not a page. */
type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/** One agent by identifier. A code-defined agent answers too, with `source: 'code'` and no hash. */
export async function getAgentDefinition(id: string, options?: Options): Promise<AgentDetail> {
  return detailSchema.parse(await callBureau('bureau.agents.definitions.get', { id }, options));
}

/**
 * The model a person chose for a code agent (a built-in agent, or a running plugin's), as
 * `provider/model`, or `null` when the agent keeps its own. A code agent's definition does not name
 * the model while no provider serves it, so this is how a schedule learns the agent needs one. An
 * identifier that is no code agent the catalog runs is a `NotFound` fault.
 */
export async function getAgentOverrideModel(id: string, options?: Options): Promise<string | null> {
  const answer = z
    .object({ overrides: z.object({ model: z.string().nullable().default(null) }) })
    .parse(await callBureau('bureau.agents.overrides.get', { id }, options));
  return answer.overrides.model;
}

/** The versions of the agent that have run, most recently run first. */
export async function listAgentRevisions(
  id: string,
  options?: Options,
): Promise<readonly AgentRevision[]> {
  const result = revisionsSchema.parse(
    await callBureau('bureau.agents.definitions.revisions', { id }, options),
  );
  return result.revisions;
}

const referencesSchema = z.object({
  schedules: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
  workflows: z.array(z.object({ id: z.string(), title: z.string().nullable() })),
  hooks: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
});

/**
 * What finds an agent by its identifier (`bureau.agents.references`): the schedules that run it, the
 * workflows with a step that calls it, and the hooks scoped to it, each with its name or title
 * (`null` when it has none). Each stops finding the agent once it is deleted.
 */
export type AgentReferences = z.infer<typeof referencesSchema>;

/** What finds the agent by its identifier, and so stops finding it once it is deleted. */
export async function listAgentReferences(id: string, options?: Options): Promise<AgentReferences> {
  return referencesSchema.parse(
    await callBureau('bureau.agents.references', { agentName: id }, options),
  );
}

const listingSchema = z.object({
  id: z.string(),
  source: z.enum(['code', 'file']),
  /** `unavailable` is a code agent of a disabled plugin: it can be read and duplicated, never run. */
  state: z.enum(['ready', 'invalid', 'unavailable']),
  unavailable: unavailableSchema,
  name: z.string(),
  description: z.string().nullable(),
  a2a: z.boolean(),
  hash: z.string().nullable(),
  problem: problemSchema.nullable(),
});

/** One entry of `bureau.agents.definitions.list`, which holds the files the Bureau cannot use. */
export type AgentListing = z.infer<typeof listingSchema>;

const listingPageSchema = z.object({
  agents: z.array(listingSchema),
  nextOffset: z.number().nullable(),
});

/** The largest page `bureau.agents.definitions.list` answers. */
const LISTING_PAGE_SIZE = 100;

/**
 * Every agent the definitions list holds, code-defined and file, `ready` and `invalid` alike.
 * `bureau.agents.list` leaves an invalid file out, because it lists what can run; this is the
 * list that says an agent file is broken. It follows the pages to the end.
 */
export async function listAgentDefinitions(options?: Options): Promise<readonly AgentListing[]> {
  const listings: AgentListing[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page: z.infer<typeof listingPageSchema> = listingPageSchema.parse(
      await callBureau(
        'bureau.agents.definitions.list',
        { limit: LISTING_PAGE_SIZE, offset },
        options,
      ),
    );
    listings.push(...page.agents);
    offset = page.nextOffset;
  }
  return listings;
}

/**
 * Whether a catalog row is one an agent could run on now. The catalog keeps the rows of a provider
 * with no key saved, and of a model turned off, marked `unavailable` (COR-2143), so a row in the
 * catalog does not say a provider is connected: this is the one rule, the one the host's
 * `no-provider` attention item applies, for every page that asks.
 */
export function isAvailableModel(row: Pick<CatalogModel, 'availability'>): boolean {
  return row.availability !== 'unavailable';
}

/** Whether the catalog holds a model an agent could run on: false is the no-provider state. */
export function hasAvailableModel(catalog: {
  readonly models: readonly Pick<CatalogModel, 'availability'>[];
}): boolean {
  return catalog.models.some(isAvailableModel);
}

/** The models and tools an agent may name. */
export async function getAgentCatalog(options?: Options): Promise<AgentCatalog> {
  return catalogSchema.parse(await callBureau('bureau.agents.catalog', {}, options));
}

/** Writes a new agent file. A taken identifier is a `Conflict` fault. */
export async function createAgent(
  id: string,
  definition: AgentDefinitionInput,
  options?: Options,
): Promise<AgentWriteResult> {
  return writeResultSchema.parse(
    await callBureau('bureau.agents.definitions.create', { id, definition }, options),
  );
}

/** Replaces the agent's file, if it still hashes to `expectedHash`. */
export async function updateAgent(
  id: string,
  expectedHash: string,
  definition: AgentDefinitionInput,
  options?: Options,
): Promise<AgentWriteResult> {
  return writeResultSchema.parse(
    await callBureau('bureau.agents.definitions.update', { id, expectedHash, definition }, options),
  );
}

/**
 * Copies a plugin's read-only agent (`plugin:name`) into the owner's agents as `name`, with its
 * tools unversioned. A name the owner already uses is a `Conflict` (`agent-file-exists`).
 */
export async function duplicateAgent(id: string, options?: Options): Promise<AgentWriteResult> {
  return writeResultSchema.parse(
    await callBureau('bureau.agents.definitions.duplicate', { id }, options),
  );
}

const triedAgentSchema = z.object({
  contextId: z.string(),
  agentName: z.string(),
  taskId: z.string(),
});

/** What `bureau.agents.try` started: the throwaway chat, and the name its agent runs under. */
export type TriedAgent = z.infer<typeof triedAgentSchema>;

/**
 * Starts a throwaway chat with a definition that is not saved (`bureau.agents.try`, COR-1911) and
 * sends it `message`. Nothing is written: no agent file, no memory, and the chat is left out of the
 * chat list. The agent lives for that chat alone, so deleting the chat (`deleteContext`) ends it.
 * A definition the Bureau would refuse as a file is an `Unprocessable` fault naming each field.
 */
export async function tryAgent(
  definition: AgentDefinitionInput,
  message: string,
  options?: Options,
): Promise<TriedAgent> {
  return triedAgentSchema.parse(
    await callBureau('bureau.agents.try', { definition, message }, options),
  );
}

/** Deletes the agent's file, if it still hashes to `expectedHash`. */
export async function deleteAgent(
  id: string,
  expectedHash: string,
  options?: Options,
): Promise<AgentWriteResult> {
  return writeResultSchema.parse(
    await callBureau('bureau.agents.definitions.delete', { id, expectedHash }, options),
  );
}

/** The saved versions of the agent, newest first, whether or not each ran (`bureau.agents.versions.list`). */
export async function listAgentVersions(
  id: string,
  options?: Options,
): Promise<readonly AgentVersion[]> {
  return versionsSchema.parse(await callBureau('bureau.agents.versions.list', { id }, options))
    .versions;
}

/**
 * Writes version `revision` back to the agent's file as a new version
 * (`bureau.agents.versions.restore`). `expectedHash` is the hash of the file as
 * `bureau.agents.definitions.get` returns it, never a version's own `hash`.
 */
export async function restoreAgentVersion(
  id: string,
  revision: number,
  expectedHash: string,
  options?: Options,
): Promise<AgentWriteResult> {
  return writeResultSchema
    .extend({ revision: z.number().int().nullable() })
    .parse(
      await callBureau('bureau.agents.versions.restore', { id, revision, expectedHash }, options),
    );
}

/** Why an identifier cannot be used for a new agent. */
export type IdentifierConflictReason = 'agent-file-exists' | 'shadows-code-agent';

/**
 * The faults the editor tells apart. `Conflict` and `StaleRevision` share an HTTP status, so they
 * are told apart by the wire fault code the envelope carries, never by the status.
 *
 * - `stale`: the file changed on disk since the caller read it. `currentHash` is what is there now.
 * - `not-found`: there is no such agent, or the file is gone.
 * - `identifier-taken`: a create named an identifier that a file or a code-defined agent holds.
 * - `rejected`: the definition would not load (the model or a tool is not offered, or a field is
 *   not valid), or this Bureau cannot write agents. Nothing was written.
 * - `forbidden`: the caller may not use the operation.
 * - `other`: anything else, such as a Bureau that did not answer.
 */
export type AgentFault =
  | { readonly kind: 'stale'; readonly currentHash: string | null }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'identifier-taken'; readonly reason: IdentifierConflictReason }
  | { readonly kind: 'rejected'; readonly message: string }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'other'; readonly message: string };

function isIdentifierConflictReason(value: unknown): value is IdentifierConflictReason {
  return value === 'agent-file-exists' || value === 'shadows-code-agent';
}

/**
 * The issues an `InvalidParams` fault carries, as `path: message` joined by `; `, or `undefined`
 * when it carries none. Weft answers every parse failure with the fixed message `invalid params`
 * and puts the offending key only in `data.issues`, so the editor must read it from there.
 */
function issueSummaryOf(data: Record<string, unknown>): string | undefined {
  const issues = data['issues'];
  if (!Array.isArray(issues)) return undefined;
  const lines: string[] = [];
  for (const issue of issues as unknown[]) {
    if (typeof issue !== 'object' || issue === null) continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof message !== 'string') continue;
    const segments = Array.isArray(path) ? (path as unknown[]).map(String) : [];
    lines.push(segments.length === 0 ? message : `${segments.join('.')}: ${message}`);
  }
  return lines.length === 0 ? undefined : lines.join('; ');
}

/** Sorts a thrown fault into the {@link AgentFault} the editor shows. */
export function agentFaultOf(error: unknown): AgentFault {
  if (!(error instanceof HttpClientError)) {
    return {
      kind: 'other',
      message: error instanceof Error ? error.message : 'The server did not answer.',
    };
  }
  const data = error.data;
  switch (data?.['weftCode']) {
    case 'StaleRevision': {
      const current = data['currentRevision'];
      return { kind: 'stale', currentHash: typeof current === 'string' ? current : null };
    }
    case 'NotFound':
      return { kind: 'not-found' };
    case 'Conflict': {
      const reason = data['reason'];
      return isIdentifierConflictReason(reason)
        ? { kind: 'identifier-taken', reason }
        : { kind: 'other', message: error.message };
    }
    case 'InvalidParams': {
      const summary = issueSummaryOf(data);
      return {
        kind: 'rejected',
        message: summary === undefined ? error.message : `${error.message}: ${summary}`,
      };
    }
    case 'Unprocessable':
    case 'UnsupportedCapability':
      return { kind: 'rejected', message: error.message };
    case 'Forbidden':
      return { kind: 'forbidden' };
    default:
      return { kind: 'other', message: error.message };
  }
}
