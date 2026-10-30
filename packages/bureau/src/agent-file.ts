/**
 * The agent file format (COR-1524): one agent as a Markdown file in a directory the host names.
 *
 * A file is YAML frontmatter followed by a body. The frontmatter describes the agent and the body
 * is its instructions:
 *
 * ```md
 * ---
 * name: Researcher
 * description: Finds sources
 * model: anthropic/claude-sonnet-4-5
 * models: [anthropic/claude-sonnet-4-5, openai/gpt-4.1]
 * tools: [lookup-order]
 * a2a: false
 * ---
 * You are a careful researcher.
 * ```
 *
 * The filename without `.md` is the agent's identifier. This module is the pure half: parsing,
 * validating the frontmatter against {@link agentFileFrontmatterSchema}, serializing, and hashing.
 * It touches no file and no catalog; `agent-file-catalog.ts` does both.
 *
 * @module agent-file
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { AgentSkillDescriptor } from '@lostgradient/operative';
import { CORE_SCHEMA, load as loadYaml, YAMLException } from 'js-yaml';
import { z } from 'zod';

import { agentExamplesSchema } from './agent-examples';
import { emitMapping, rewriteFrontmatter } from './agent-file-frontmatter';

/** What an agent's identifier must look like: it doubles as a path segment later. */
export const AGENT_IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** The longest an agent's identifier may be, in characters: the same cap workflow identifiers have. */
export const AGENT_IDENTIFIER_MAX_LENGTH = 64;

/** The extension an agent file carries. Matched exactly: `x.MD` is another kind of file. */
export const AGENT_FILE_EXTENSION = '.md';

/** The largest agent file Bureau reads, in bytes. A larger one is `invalid`. */
export const AGENT_FILE_SIZE_LIMIT = 256 * 1024;

/**
 * The frontmatter fields Bureau knows and writes. Any other top-level key is kept and ignored.
 * `examples` is read (it reaches `bureau.agents.list`) but is not written, so it is not listed: a
 * rewrite keeps it in the file as it keeps any key outside this list.
 */
export const AGENT_FILE_KNOWN_KEYS = [
  'name',
  'description',
  'model',
  'models',
  'tools',
  'skillDescriptors',
  'a2a',
  'stepLimit',
  'retry',
] as const;

/** Why a file cannot be used as an agent. Carried on the listing, and on a refused write. */
export type AgentFileProblemCode =
  | 'invalid-identifier'
  | 'invalid-frontmatter'
  | 'unknown-model'
  | 'unknown-tool'
  | 'shadows-code-agent'
  | 'missing-frontmatter'
  | 'invalid-yaml'
  | 'not-utf8'
  | 'file-too-large'
  | 'unreadable';

/** One schema failure: where it is and what is wrong. */
export interface AgentFileIssue {
  readonly path: string;
  readonly message: string;
}

/** A file that cannot be used, as plain data a listing can carry. */
export interface AgentFileProblem {
  readonly code: AgentFileProblemCode;
  readonly message: string;
  /** Every schema failure, for `invalid-frontmatter`; the missing names, for `unknown-tool`. */
  readonly issues?: readonly AgentFileIssue[];
}

export const agentSkillDescriptorSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()),
  examples: z.array(z.string()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
});

/** The most steps an agent file may allow a run (`stepLimit`). */
export const AGENT_STEP_LIMIT_MAXIMUM = 1000;
/** The most attempts a file's `retry` may allow one generate call, the first included. */
export const AGENT_RETRY_ATTEMPTS_MAXIMUM = 10;
/** The longest a file's `retry` may wait between attempts, in milliseconds. */
export const AGENT_RETRY_DELAY_MAXIMUM_MILLISECONDS = 60_000;

/** An agent's step limit: the cap on the steps of one run, which Operative calls `maximumSteps`. */
export const agentStepLimitSchema = z.number().int().min(1).max(AGENT_STEP_LIMIT_MAXIMUM);

/**
 * How a run retries a failed generate call: Operative's `RetryOptions`, narrowed to what a file
 * may say. `attempts` counts the first call, so `1` retries nothing. Omitted, the wait is `0` and
 * `jitter` is `false`.
 */
export const agentRetrySchema = z.strictObject({
  attempts: z.number().int().min(1).max(AGENT_RETRY_ATTEMPTS_MAXIMUM),
  delayMilliseconds: z.number().int().min(0).max(AGENT_RETRY_DELAY_MAXIMUM_MILLISECONDS).optional(),
  jitter: z.boolean().optional(),
});

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/** Whether `entry` is written `<provider>/<model-or-alias>`: text on both sides of the first `/`. */
function isModelEntry(entry: string): boolean {
  const separator = entry.indexOf('/');
  return separator > 0 && separator < entry.length - 1;
}

/**
 * The frontmatter of an agent file. Unknown top-level keys are allowed so a file may carry
 * fields another tool reads; Bureau keeps them when it rewrites the file and ignores them.
 */
export const agentFileFrontmatterSchema = z
  .looseObject({
    /** A display label. Defaults to the identifier. Need not be unique. */
    name: z.string().trim().min(1).nullish(),
    description: z.string().nullish(),
    /** `<provider>/<model-or-alias>`, split on the first `/`; checked against the model catalog. */
    model: z.string().min(1),
    /**
     * The models a session of this agent may be switched to (COR-1559), each written like `model`.
     * It narrows the choice; without it the deployment's catalog applies. Checked by
     * {@link checkModelsList} when the file is parsed, never against the catalog.
     */
    models: z.array(z.string()).nullish(),
    /** Names from the deployment's tool catalog. */
    tools: z
      .array(z.string().min(1))
      .refine(unique, { message: 'tool names must be unique' })
      .nullish(),
    /** Descriptive Agent Card skills (COR-1301), never executable skills. */
    skillDescriptors: z
      .array(agentSkillDescriptorSchema)
      .refine((descriptors) => unique(descriptors.map((descriptor) => descriptor.id)), {
        message: 'skill ids must be unique',
      })
      .nullish(),
    /**
     * Whether the agent opts into A2A, the agent-to-agent protocol. A strict boolean; defaults to
     * `false`. Chat and every other surface serve a ready agent whatever this says.
     */
    a2a: z.boolean().nullish(),
    /** The most steps one run may take. An integer from 1 to 1000; absent, Operative's default. */
    stepLimit: agentStepLimitSchema.nullish(),
    /** How a run retries a failed generate call. Absent, it does not. */
    retry: agentRetrySchema.nullish(),
    /**
     * Prompts that show what a person might ask the agent, which a new chat offers as buttons. Read
     * only: it is not in {@link AGENT_FILE_KNOWN_KEYS}, so a rewrite of the file keeps it as it is.
     */
    examples: agentExamplesSchema.nullish(),
  })
  .superRefine((frontmatter, context) => checkModelsList(frontmatter, context));

/**
 * The checks a `models` list must pass, which hold whatever the model catalog holds (COR-1559):
 * every entry is `<provider>/<name>`, non-empty and unique, and the list is not empty and
 * includes the default `model`, compared as the literal string the file wrote. Each failure is
 * at the entry's own path, `models.<index>`, or at `models` for the list as a whole.
 */
export function checkModelsList(
  frontmatter: { readonly model: string; readonly models?: readonly string[] | null | undefined },
  context: z.RefinementCtx,
): void {
  const { models, model } = frontmatter;
  if (models === undefined || models === null) return;
  if (models.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['models'],
      message: 'models must list at least one model; leave it out to allow the whole catalog',
    });
    return;
  }
  const seen = new Set<string>();
  for (const [index, entry] of models.entries()) {
    if (entry === '') {
      context.addIssue({ code: 'custom', path: ['models', index], message: 'must not be empty' });
    } else if (!isModelEntry(entry)) {
      context.addIssue({
        code: 'custom',
        path: ['models', index],
        message: `"${entry}" must be written <provider>/<model>`,
      });
    } else if (seen.has(entry)) {
      context.addIssue({
        code: 'custom',
        path: ['models', index],
        message: `"${entry}" is listed more than once`,
      });
    }
    seen.add(entry);
  }
  if (!models.includes(model)) {
    context.addIssue({
      code: 'custom',
      path: ['models'],
      message: `models must include the default model "${model}"`,
    });
  }
}

/**
 * A definition as a snapshot stores it. Read back with the defaults a later field would need, so
 * a snapshot written before that field existed still resumes; a stored value that is not valid
 * is refused at the boundary rather than failing later as a `TypeError`.
 */
export const agentFileDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  model: z.string().min(1),
  /** The models a session may be switched to (COR-1559); absent for a snapshot that has none. */
  models: z.array(z.string().min(1)).optional(),
  tools: z.array(z.string().min(1)).default([]),
  /** Absent from a snapshot written before the field was renamed from `skills`; read as none. */
  skillDescriptors: z.array(agentSkillDescriptorSchema).default([]),
  /** Absent from a snapshot written before the A2A opt-in existed; read as `false`. */
  a2a: z.boolean().default(false),
  /** Absent from a snapshot written before the field existed, and from a file that has none. */
  stepLimit: agentStepLimitSchema.optional(),
  /** Absent from a snapshot written before the field existed, and from a file that has none. */
  retry: agentRetrySchema.optional(),
  /** Prompts a new chat offers (see the frontmatter's `examples`); absent for a file that has none. */
  examples: agentExamplesSchema.optional(),
  instructions: z.string(),
});

/** A file's `retry`, as written. */
export interface AgentRetry {
  /** The attempts one generate call gets, the first included, so `1` retries nothing. */
  readonly attempts: number;
  /** The wait before each retry, in milliseconds. Absent, `0`. */
  readonly delayMilliseconds?: number | undefined;
  /** Whether the wait is jittered. Absent, `false`. */
  readonly jitter?: boolean | undefined;
}

/** The frontmatter as written, before defaults. */
export type AgentFileFrontmatter = z.infer<typeof agentFileFrontmatterSchema>;

/** What an agent is, once defaults are applied. This is what a snapshot stores. */
export interface AgentFileDefinition {
  readonly name: string;
  readonly description: string | null;
  readonly model: string;
  /**
   * The models a session of the agent may be switched to (COR-1559), each `<provider>/<name>` as
   * `model` is, and including `model`. Absent when the file lists none: the deployment's model
   * catalog then applies.
   */
  readonly models?: readonly string[];
  readonly tools: readonly string[];
  /** Descriptive Agent Card skills (COR-1301), never executable skills. */
  readonly skillDescriptors: readonly AgentSkillDescriptor[];
  /** Whether the agent opts into A2A. This part only records it; the A2A mount reads it. */
  readonly a2a: boolean;
  /** The most steps one run may take. Absent when the file sets none: Operative's default applies. */
  readonly stepLimit?: number;
  /** How a run retries a failed generate call. Absent when the file sets none: it does not retry. */
  readonly retry?: AgentRetry;
  /**
   * Prompts that show what a person might ask the agent, as the file's `examples` lists them.
   * Absent when it lists none. A caller never supplies them: they stay in the file through a write.
   */
  readonly examples?: readonly string[];
  readonly instructions: string;
}

/**
 * Every key of {@link AgentFileDefinition}, in the order a version's `changedKeys` lists them.
 * Typed as a `Record`, so a key added to the interface and left out here fails the type-check.
 */
const definitionKeyTable: Record<keyof AgentFileDefinition, true> = {
  name: true,
  description: true,
  model: true,
  models: true,
  tools: true,
  skillDescriptors: true,
  a2a: true,
  examples: true,
  instructions: true,
};

/** The keys of {@link AgentFileDefinition}, which a copy or a comparison of one walks. */
export const AGENT_FILE_DEFINITION_KEYS = Object.freeze(
  Object.keys(definitionKeyTable) as (keyof AgentFileDefinition)[],
);

type AssertTrue<Condition extends true> = Condition;

/**
 * Compiles only while {@link agentFileDefinitionSchema} names exactly the keys of
 * {@link AgentFileDefinition}: a stored definition is parsed through the schema, which drops a key
 * it does not name, so a key missing from it would be lost from every version read back.
 */
export type AgentFileDefinitionSchemaIsExhaustive = AssertTrue<
  [keyof AgentFileDefinition] extends [keyof z.output<typeof agentFileDefinitionSchema>]
    ? [keyof z.output<typeof agentFileDefinitionSchema>] extends [keyof AgentFileDefinition]
      ? true
      : false
    : false
>;

/** What a caller supplies to `create` or `update`; the defaults are the file's. */
export interface AgentFileDefinitionInput {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly model: string;
  /** See {@link AgentFileDefinition.models}. Omitting it on an update removes it, as for `tools`. */
  readonly models?: readonly string[] | undefined;
  readonly tools?: readonly string[] | undefined;
  /** See {@link AgentFileDefinition.skillDescriptors}. */
  readonly skillDescriptors?: readonly AgentSkillDescriptor[] | undefined;
  /** See {@link AgentFileDefinition.a2a}. An update that omits it keeps the file's value. */
  readonly a2a?: boolean | undefined;
  /**
   * See {@link AgentFileDefinition.stepLimit}. An update that omits it keeps the file's value; `null`
   * removes it.
   */
  readonly stepLimit?: number | null | undefined;
  /**
   * See {@link AgentFileDefinition.retry}. An update that omits it keeps the file's value; `null`
   * removes it.
   */
  readonly retry?: AgentRetry | null | undefined;
  readonly instructions: string;
}

/** A file read and understood. `raw` is every frontmatter key, in file order. */
export interface ParsedAgentFile {
  readonly definition: AgentFileDefinition;
  readonly raw: Readonly<Record<string, unknown>>;
  /** The frontmatter text between the fences, exactly as the file has it. */
  readonly frontmatter: string;
  readonly body: string;
  /** The file began with a byte order mark, which a rewrite keeps. */
  readonly byteOrderMark: boolean;
  /** The file's line ending, which a rewrite of the frontmatter keeps. */
  readonly lineEnding: '\n' | '\r\n';
}

export type ParseAgentFileResult =
  | { readonly ok: true; readonly file: ParsedAgentFile }
  | { readonly ok: false; readonly problem: AgentFileProblem };

/** The SHA-256 of a file's exact bytes, as lowercase hex. This is the `expectedHash` of a write. */
export function hashAgentFileBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const textEncoder = new TextEncoder();

/** Decode a file's bytes as UTF-8, or `undefined` when they are not. */
export function decodeAgentFile(bytes: Uint8Array): string | undefined {
  try {
    return textDecoder.decode(bytes);
  } catch {
    return undefined;
  }
}

interface SplitFile {
  readonly frontmatter: string;
  readonly body: string;
  readonly lineEnding: '\n' | '\r\n';
}

/**
 * Split `text` at its frontmatter fences. The first line must be exactly `---` and the
 * frontmatter ends at the next line that is exactly `---`. The body is everything after that
 * line's terminator, untouched.
 */
function splitFrontmatter(text: string): SplitFile | undefined {
  const firstBreak = text.indexOf('\n');
  if (firstBreak < 0) return undefined;
  const lineEnding = text[firstBreak - 1] === '\r' ? '\r\n' : '\n';
  if (text.slice(0, firstBreak).replace(/\r$/, '') !== '---') return undefined;
  let lineStart = firstBreak + 1;
  const frontmatterStart = lineStart;
  while (lineStart <= text.length) {
    const lineBreak = text.indexOf('\n', lineStart);
    const lineEnd = lineBreak < 0 ? text.length : lineBreak;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, '');
    if (line === '---') {
      const bodyStart = lineBreak < 0 ? text.length : lineBreak + 1;
      return {
        frontmatter: text.slice(frontmatterStart, lineStart),
        body: text.slice(bodyStart),
        lineEnding,
      };
    }
    if (lineBreak < 0) return undefined;
    lineStart = lineBreak + 1;
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A retry without the keys it leaves out, so a definition holds exactly what a file wrote. */
function retryOf(retry: AgentRetry): AgentRetry {
  return {
    attempts: retry.attempts,
    ...(retry.delayMilliseconds === undefined
      ? {}
      : { delayMilliseconds: retry.delayMilliseconds }),
    ...(retry.jitter === undefined ? {} : { jitter: retry.jitter }),
  };
}

/** Apply the schema's defaults to validated frontmatter. */
function toDefinition(
  id: string,
  frontmatter: AgentFileFrontmatter,
  instructions: string,
): AgentFileDefinition {
  return {
    name: frontmatter.name ?? id,
    description: frontmatter.description ?? null,
    model: frontmatter.model,
    ...(frontmatter.models == null ? {} : { models: frontmatter.models }),
    tools: frontmatter.tools ?? [],
    // Zod types an absent optional key as possibly `undefined`; it is never present as one.
    skillDescriptors: (frontmatter.skillDescriptors ?? []) as readonly AgentSkillDescriptor[],
    a2a: frontmatter.a2a ?? false,
    ...(frontmatter.stepLimit == null ? {} : { stepLimit: frontmatter.stepLimit }),
    ...(frontmatter.retry == null ? {} : { retry: retryOf(frontmatter.retry) }),
    ...(frontmatter.examples == null ? {} : { examples: frontmatter.examples }),
    instructions,
  };
}

/**
 * Parse a file's text. Never throws: every way a file can fail is a typed `problem`. The
 * identifier is not checked here (the caller owns the filename), only used for the `name` default.
 */
export function parseAgentFile(id: string, rawText: string): ParseAgentFileResult {
  const byteOrderMark = rawText.startsWith('﻿');
  const text = byteOrderMark ? rawText.slice(1) : rawText;
  const split = splitFrontmatter(text);
  if (split === undefined) {
    return {
      ok: false,
      problem: {
        code: 'missing-frontmatter',
        message:
          'The file has no frontmatter. It must begin with a line of "---" and close the frontmatter with another.',
      },
    };
  }
  let loaded: unknown;
  try {
    loaded = loadYaml(split.frontmatter, { schema: CORE_SCHEMA });
  } catch (error) {
    const where =
      error instanceof YAMLException && error.mark
        ? ` at line ${error.mark.line + 1}, column ${error.mark.column + 1}`
        : '';
    const reason = error instanceof YAMLException ? error.reason : 'it could not be parsed';
    return {
      ok: false,
      problem: {
        code: 'invalid-yaml',
        message: `The frontmatter is not valid YAML${where}: ${reason}.`,
      },
    };
  }
  const mapping = loaded ?? {};
  if (!isPlainRecord(mapping)) {
    return {
      ok: false,
      problem: {
        code: 'invalid-frontmatter',
        message: 'The frontmatter must be a mapping.',
        issues: [],
      },
    };
  }
  const checked = agentFileFrontmatterSchema.safeParse(mapping);
  if (!checked.success) {
    const issues = checked.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(frontmatter)',
      message: issue.message,
    }));
    return {
      ok: false,
      problem: {
        code: 'invalid-frontmatter',
        message: `The frontmatter is invalid: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}.`,
        issues,
      },
    };
  }
  return {
    ok: true,
    file: {
      definition: toDefinition(id, checked.data, split.body),
      raw: mapping,
      frontmatter: split.frontmatter,
      body: split.body,
      byteOrderMark,
      lineEnding: split.lineEnding,
    },
  };
}

/** The known keys of `definition`, as the frontmatter of a file would hold them. */
function knownFrontmatter(definition: AgentFileDefinitionInput): Record<string, unknown> {
  const known: Record<string, unknown> = {};
  if (definition.name !== undefined) known['name'] = definition.name;
  if (definition.description !== undefined && definition.description !== null) {
    known['description'] = definition.description;
  }
  known['model'] = definition.model;
  if (definition.models !== undefined) known['models'] = [...definition.models];
  if (definition.tools !== undefined && definition.tools.length > 0) {
    known['tools'] = [...definition.tools];
  }
  if (definition.skillDescriptors !== undefined && definition.skillDescriptors.length > 0) {
    known['skillDescriptors'] = definition.skillDescriptors.map((descriptor) => ({
      ...descriptor,
    }));
  }
  if (definition.a2a !== undefined) known['a2a'] = definition.a2a;
  if (definition.stepLimit != null) known['stepLimit'] = definition.stepLimit;
  if (definition.retry != null) known['retry'] = retryOf(definition.retry);
  return known;
}

/** The bytes of a brand-new agent file. */
export function serializeNewAgentFile(definition: AgentFileDefinitionInput): Uint8Array {
  const frontmatter = emitMapping(
    knownFrontmatter({ ...definition, a2a: definition.a2a ?? false }),
    '\n',
  );
  return textEncoder.encode(`---\n${frontmatter}---\n${definition.instructions}`);
}

/** `input` with every default applied, as a definition. */
export function resolveAgentFileDefinition(
  id: string,
  input: AgentFileDefinitionInput,
): AgentFileDefinition {
  return {
    name: input.name ?? id,
    description: input.description ?? null,
    model: input.model,
    ...(input.models === undefined ? {} : { models: input.models }),
    tools: input.tools ?? [],
    skillDescriptors: input.skillDescriptors ?? [],
    a2a: input.a2a ?? false,
    ...(input.stepLimit == null ? {} : { stepLimit: input.stepLimit }),
    ...(input.retry == null ? {} : { retry: retryOf(input.retry) }),
    instructions: input.instructions,
  };
}

/**
 * The bytes of `existing` rewritten to hold `definition`, or `undefined` when nothing changes.
 *
 * Every frontmatter key Bureau does not know stays, in its place with its value. The known keys
 * are replaced in place, or appended when the file lacked them. The body is the supplied
 * instructions, so an unchanged body is the file's own text byte for byte. A frontmatter whose
 * meaning does not change keeps its original text; one that does is re-emitted by `js-yaml`,
 * which drops YAML comments and reformats it.
 */
export function serializeUpdatedAgentFile(
  id: string,
  existing: ParsedAgentFile,
  input: AgentFileDefinitionInput,
): Uint8Array | undefined {
  const before = existing.definition;
  // A key the caller leaves out (`a2a`, `stepLimit`, `retry`) is not a change to it: the file keeps
  // the value it has, and a file with no such key is not given one.
  const keptA2a = input.a2a === undefined;
  const next = resolveAgentFileDefinition(id, {
    ...input,
    ...(keptA2a ? { a2a: before.a2a } : {}),
    ...(input.stepLimit === undefined ? { stepLimit: before.stepLimit } : {}),
    ...(input.retry === undefined ? { retry: before.retry } : {}),
  });
  // `examples` is the file's own and an input never carries it, so it is not a change.
  const { examples: _kept, ...beforeKnown } = before;
  const frontmatterChanged = !isDeepStrictEqual(
    { ...beforeKnown, instructions: '' },
    { ...next, instructions: '' },
  );
  if (!frontmatterChanged && next.instructions === existing.body) return undefined;
  const prefix = existing.byteOrderMark ? '\uFEFF' : '';
  const fence = `---${existing.lineEnding}`;
  let frontmatter = existing.frontmatter;
  if (frontmatterChanged) {
    frontmatter = rewriteFrontmatter(
      existing,
      knownFrontmatter({
        ...input,
        ...(keptA2a && Object.hasOwn(existing.raw, 'a2a') ? { a2a: before.a2a } : {}),
        ...(input.stepLimit === undefined ? { stepLimit: before.stepLimit } : {}),
        ...(input.retry === undefined ? { retry: before.retry } : {}),
      }),
      AGENT_FILE_KNOWN_KEYS,
      existing.lineEnding,
    );
  }
  return textEncoder.encode(`${prefix}${fence}${frontmatter}${fence}${next.instructions}`);
}

/** The identifier a filename stem names, or the reason it cannot be one. */
export function checkAgentIdentifier(stem: string): AgentFileProblem | undefined {
  if (AGENT_IDENTIFIER_PATTERN.test(stem) && stem.length <= AGENT_IDENTIFIER_MAX_LENGTH) {
    return undefined;
  }
  return {
    code: 'invalid-identifier',
    message: `"${stem.length > 80 ? `${stem.slice(0, 80)}…` : stem}" is not a valid agent identifier. Use at most ${AGENT_IDENTIFIER_MAX_LENGTH} lowercase letters, digits, and hyphens, starting and ending with a letter or digit.`,
  };
}

/** What a refused write or lookup reports: a file problem, or the state of the file on disk. */
export type AgentFileErrorCode =
  | AgentFileProblemCode
  | 'agent-file-exists'
  | 'agent-file-changed'
  | 'agent-file-not-found'
  | 'agent-file-unreadable'
  | 'agent-version-not-found'
  | 'agent-directory-not-configured';

/** A write or read of an agent file that was refused. `problem` carries the detail, when there is any. */
export class AgentFileError extends Error {
  readonly code: AgentFileErrorCode;
  readonly problem: AgentFileProblem | undefined;

  constructor(code: AgentFileErrorCode, message: string, problem?: AgentFileProblem) {
    super(message);
    this.name = 'AgentFileError';
    this.code = code;
    this.problem = problem;
  }
}

/**
 * A write that lost to the file's current state: `create` found the file, or `update`/`delete`
 * found bytes that do not hash to `expectedHash`. `currentHash` is the hash of what is there.
 */
export class AgentFileConflictError extends AgentFileError {
  readonly currentHash: string | undefined;

  constructor(
    code: 'agent-file-exists' | 'agent-file-changed',
    message: string,
    currentHash?: string,
  ) {
    super(code, message);
    this.name = 'AgentFileConflictError';
    this.currentHash = currentHash;
  }
}

/** A run could not be built from the snapshot it recorded. */
export class AgentSnapshotError extends Error {
  readonly code: 'snapshot-missing' | 'snapshot-unresolvable';
  readonly agentId: string;
  readonly hash: string;

  constructor(
    code: 'snapshot-missing' | 'snapshot-unresolvable',
    agentId: string,
    hash: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentSnapshotError';
    this.code = code;
    this.agentId = agentId;
    this.hash = hash;
  }
}
