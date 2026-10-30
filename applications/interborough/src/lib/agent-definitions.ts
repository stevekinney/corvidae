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
 * (`AGENT_IDENTIFIER_PATTERN` and `AGENT_IDENTIFIER_MAX_LENGTH` in its `agent-file.ts`); the
 * browser cannot import that module, so the editor repeats them to answer while the person types,
 * and `src/host/host-agent-definitions.test.ts` fails if the two drift apart. The Bureau still
 * refuses an identifier that breaks them.
 */
export const AGENT_IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/** The longest an agent identifier may be, in characters. */
export const AGENT_IDENTIFIER_MAX_LENGTH = 64;

/**
 * The agent's `skillDescriptors` entry. The editor never edits one, but a save sends them back unchanged, so
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

/** An agent definition's `skillDescriptors` entry, as the Bureau reads it back. */
export type AgentSkill = z.infer<typeof skillSchema>;

const definitionSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  model: z.string(),
  /**
   * The models a session of the agent may be switched to (COR-1559), or `null` when the file lists
   * none. The editor never edits it, but a save sends it back unchanged, as it does `skillDescriptors`: an
   * update that omits it removes the list.
   */
  models: z.array(z.string()).nullable().default(null),
  tools: z.array(z.string()),
  skillDescriptors: z.array(skillSchema),
  a2a: z.boolean(),
  instructions: z.string(),
});

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

const detailSchema = z.object({
  id: z.string(),
  source: z.enum(['code', 'file']),
  state: z.enum(['ready', 'invalid']),
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
      skillDescriptors: z.array(skillSchema),
      instructions: z.string().nullable(),
    })
    .nullable()
    // The Bureau always sends it. A stub that predates the key reads as a file agent.
    .default(null),
});

/** One agent as `bureau.agents.definitions.get` shows it. */
export type AgentDetail = z.infer<typeof detailSchema>;

const revisionsSchema = z.object({
  revisions: z.array(z.object({ hash: z.string(), firstRunAt: z.string(), lastRunAt: z.string() })),
});

/** A version of the agent's definition that has run. */
export type AgentRevision = z.infer<typeof revisionsSchema>['revisions'][number];

const catalogSchema = z.object({
  models: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      aliases: z.array(z.object({ alias: z.string(), resolvesTo: z.string() })),
    }),
  ),
  tools: z.array(
    z.object({
      name: z.string(),
      /** What the model is told about the tool: a prompt, which can run to several paragraphs. */
      description: z.string(),
      /** The one line a person is shown for the tool, or `null` when the tool declares none. */
      shortDescription: z.string().nullable(),
      /** What the tool takes, as a JSON Schema, or `null` when it cannot be written as one. */
      inputSchema: z.record(z.string(), z.unknown()).nullable(),
      /** What the tool may technically do, or `null` when it declares none. */
      tier: z.enum(['read-only', 'mutating', 'dangerous']).nullable(),
      /** What happens by default when an agent calls the tool (Armorer's tier rule). */
      defaultApproval: z.enum(['allow', 'ask']),
      /** `bureau` for a tool Bureau adds, `host` for one the host provides. */
      source: z.enum(['host', 'bureau']),
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
  readonly tools: readonly string[];
  /** Carried through a save unchanged: the editor shows no control for them. */
  readonly skillDescriptors: readonly AgentSkill[];
  /** Whether the agent opts into A2A. Left out, an update keeps the file's value. */
  readonly a2a?: boolean;
  readonly instructions: string;
};

/** Where a call is sent from: an abort signal, and a `fetch` for a caller that is not a page. */
type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/** One agent by identifier. A code-defined agent answers too, with `source: 'code'` and no hash. */
export async function getAgentDefinition(id: string, options?: Options): Promise<AgentDetail> {
  return detailSchema.parse(await callBureau('bureau.agents.definitions.get', { id }, options));
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

const listingSchema = z.object({
  id: z.string(),
  source: z.enum(['code', 'file']),
  state: z.enum(['ready', 'invalid']),
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
      message: error instanceof Error ? error.message : 'The Bureau did not answer.',
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
