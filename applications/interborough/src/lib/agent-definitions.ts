/**
 * The browser's view of the Bureau's agent definitions: the operations `bureau.agents.definitions.*`
 * and `bureau.agents.catalog` (COR-1526), parsed at the boundary, and the faults a write can answer
 * with, sorted into the few the editor tells apart.
 *
 * An agent is a Markdown file, and its identifier is the filename without `.md`. Every write names
 * the `hash` of the file the caller read, so a file that changed since is refused instead of
 * overwritten. `published` is changed only by {@link publishAgent} and {@link withdrawAgent}; an
 * update never carries it.
 */
import { HttpClientError } from '@lostgradient/weft';
import { z } from 'zod';

import { callBureau, type Fetcher } from './bureau-client.ts';

/**
 * What an agent's identifier must look like, and the longest it may be. The Bureau owns both rules
 * (`AGENT_IDENTIFIER_PATTERN` and `AGENT_IDENTIFIER_MAX_LENGTH` in its `agent-file.ts`); the
 * browser cannot import that module, so the editor repeats them to answer while the person types,
 * and `src/host/agent-identifier-rules.test.ts` fails if the two drift apart. The Bureau still
 * refuses an identifier that breaks them.
 */
export const AGENT_IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const AGENT_IDENTIFIER_MAX_LENGTH = 64;

/** The agent's `skills` entry. The editor never edits one, but a save sends them back unchanged. */
const skillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  examples: z.array(z.string()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
});

export type AgentSkill = z.infer<typeof skillSchema>;

const definitionSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  model: z.string(),
  tools: z.array(z.string()),
  skills: z.array(skillSchema),
  published: z.boolean(),
  instructions: z.string(),
});

const problemSchema = z.object({
  code: z.string(),
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).nullable(),
});

export type AgentProblem = z.infer<typeof problemSchema>;

const detailSchema = z.object({
  id: z.string(),
  source: z.enum(['code', 'file']),
  state: z.enum(['ready', 'invalid']),
  name: z.string(),
  description: z.string().nullable(),
  published: z.boolean(),
  hash: z.string().nullable(),
  problem: problemSchema.nullable(),
  definition: definitionSchema.nullable(),
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
  tools: z.array(z.object({ name: z.string(), description: z.string() })),
});

/** The models and tools an agent may name, as `bureau.agents.catalog` lists them. */
export type AgentCatalog = z.infer<typeof catalogSchema>;

const writeResultSchema = z.object({ id: z.string(), hash: z.string() });

/** What a write answers: the agent's identifier and the hash of the file now on disk. */
export type AgentWriteResult = z.infer<typeof writeResultSchema>;

/**
 * What a caller supplies to create or update an agent. `published` is not part of it. An optional
 * key is left out, never sent as `undefined`.
 */
export type AgentDefinitionInput = {
  readonly name?: string;
  readonly description: string | null;
  readonly model: string;
  readonly tools: readonly string[];
  readonly skills: readonly AgentSkill[];
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

/** Sets `published: true` in the agent's file, if it still hashes to `expectedHash`. */
export async function publishAgent(
  id: string,
  expectedHash: string,
  options?: Options,
): Promise<AgentWriteResult> {
  return writeResultSchema.parse(
    await callBureau('bureau.agents.definitions.publish', { id, expectedHash }, options),
  );
}

/** Sets `published: false` in the agent's file, if it still hashes to `expectedHash`. */
export async function withdrawAgent(
  id: string,
  expectedHash: string,
  options?: Options,
): Promise<AgentWriteResult> {
  return writeResultSchema.parse(
    await callBureau('bureau.agents.definitions.withdraw', { id, expectedHash }, options),
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
    case 'Unprocessable':
    case 'InvalidParams':
    case 'UnsupportedCapability':
      return { kind: 'rejected', message: error.message };
    case 'Forbidden':
      return { kind: 'forbidden' };
    default:
      return { kind: 'other', message: error.message };
  }
}
