/**
 * COR-2119 — owner-defined validators: a JSON file in the Bungalow's `validators` folder that says
 * when a goal's work is done, so an owner who writes agents and workflows can also write the check.
 *
 * ## The file
 *
 * `<bungalow>/validators/<name>.json`, whose stem is the validator's name. The stem is a plugin name
 * (a lowercase letter first, then lowercase letters, digits and hyphens, ending in a letter or
 * digit), so it holds no `:`, which a plugin's validators (`plugin:name`) keep for themselves. The
 * file is one JSON object, closed to any key its kind does not name, and it has no version field: its
 * version is derived from what it says. Every file has a `kind` and a `description` (what the check
 * is for, in a sentence); the rest is the kind's:
 *
 * - `match` (COR-2119): `phrases` (text the attempt's answer must contain, in any letter case) and
 *   `patterns` (regular expressions, each `{ pattern, flags? }`, whose `flags` are some of `i`, `m`,
 *   `s` and `u` and default to `i`), at least one of them, and `mode`, `all` (the default) to need
 *   every one or `any` to need one.
 * - `schema` (COR-2121): `schema`, a JSON Schema (draft 2020-12) the attempt's result must satisfy,
 *   and `target`, `structured-output` (the default) for the run's validated structured output or
 *   `content` for the answer's text parsed as JSON first.
 * - `tool-called` (COR-2122): `tool`, the name of a tool (`plugin:name`) the run must have called,
 *   and `minimum`, how many successful calls it needs (default 1).
 * - `judge` (COR-2123): `model`, a row of the model catalog (`<provider>/<model>`), and `rubric`, what
 *   the answer must satisfy, which the model judges.
 *
 * A `command` kind is refused, and so is any other kind than these.
 *
 * ## Its version
 *
 * The version is the lowercase hex SHA-256 of the canonical parsed definition (the definition below,
 * with each default written out and its keys sorted), so a file spelled another way that says the
 * same thing has the same version, and an edit to what it says has another.
 *
 * ## Refusals
 *
 * A file that cannot be used is listed `invalid` with a code from {@link VALIDATOR_FILE_PROBLEM_CODES}
 * and nothing else: an identifier, never text from the file, the parser or the regular-expression
 * engine, because a refusal is reported in places that publish it.
 *
 * @module validator-file
 */

import { sha256HexSync } from '@lostgradient/cryptography';
import { isPluginName } from '@lostgradient/interborough-plugin';
import type {
  Decision,
  DecisionRequest,
  JSONValue,
  Validator,
  ValidatorOutcome,
} from '@lostgradient/operative';
import { z } from 'zod';

import { canonicalJson } from './canonical-json';
import { standardSchemaFromJsonSchema } from './decisions/json-schema-standard';

/** The extension a validator file ends in exactly. */
export const VALIDATOR_FILE_EXTENSION = '.json';

/** The largest validator file read, in bytes. */
export const VALIDATOR_FILE_SIZE_LIMIT = 64 * 1024;

/**
 * Why a validator file cannot be used. Each is an identifier (`^[A-Z][A-Z0-9_]{0,63}$`): the only
 * thing a refusal says, since it is published.
 */
export const VALIDATOR_FILE_PROBLEM_CODES = [
  /** The file is over {@link VALIDATOR_FILE_SIZE_LIMIT}. */
  'VALIDATOR_FILE_TOO_LARGE',
  /** The source could not read the file. */
  'VALIDATOR_FILE_UNREADABLE',
  'VALIDATOR_FILE_NOT_UTF8',
  /** The text is not JSON, which includes a file written only in part. */
  'VALIDATOR_FILE_NOT_JSON',
  /** The stem is not a plugin name, and so may hold no `:`. */
  'VALIDATOR_FILE_INVALID_NAME',
  /** The JSON is not an object, or `kind` is missing, or a key its kind does not take is present. */
  'VALIDATOR_FILE_INVALID_DEFINITION',
  /** `kind` is `command`, which a file cannot define. */
  'VALIDATOR_FILE_COMMAND_KIND',
  /** `kind` names no kind a file may define. */
  'VALIDATOR_FILE_UNKNOWN_KIND',
  /** A regular expression does not compile, or a flag is not one a file may set. */
  'VALIDATOR_FILE_INVALID_PATTERN',
  /** The `schema` of a `schema` file is not a JSON Schema Bureau accepts. */
  'VALIDATOR_FILE_INVALID_SCHEMA',
  /** The `model` of a `judge` file is not in the model catalog. */
  'VALIDATOR_FILE_UNKNOWN_MODEL',
] as const;

/** One of {@link VALIDATOR_FILE_PROBLEM_CODES}. */
export type ValidatorFileProblemCode = (typeof VALIDATOR_FILE_PROBLEM_CODES)[number];

const MAXIMUM_CRITERIA = 64;
const MAXIMUM_CRITERION_LENGTH = 1024;
const MAXIMUM_RUBRIC_LENGTH = 8 * 1024;
const MAXIMUM_MINIMUM_CALLS = 1000;
const FLAGS = /^(?!.*(.).*\1)[imsu]*$/;
/** A tool's name as an agent file lists it: `name` for a host's, `plugin:name` for a plugin's. */
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
/** A model catalog row as an agent file writes it. */
const MODEL_ROW = /^[^/\s]+\/\S+$/;

const text = (maximum = MAXIMUM_CRITERION_LENGTH) => z.string().min(1).max(maximum);

function isJsonValue(value: unknown, depth = 0): value is JSONValue {
  if (depth > 64) return false;
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object':
      break;
    default:
      return false;
  }
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

/** A JSON object, as a file or a record holds a JSON Schema. */
const jsonObject = z.custom<Record<string, JSONValue>>(
  (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value) && isJsonValue(value),
);

const patternEntry = z.strictObject({ pattern: text(), flags: z.string().regex(FLAGS).optional() });
const storedPatternEntry = z.strictObject({ pattern: text(), flags: z.string().regex(FLAGS) });

/** What each kind's file may say, before its defaults are written out. */
const fileSchemas = {
  match: z.strictObject({
    kind: z.literal('match'),
    description: text(),
    phrases: z.array(text()).max(MAXIMUM_CRITERIA).optional(),
    patterns: z.array(patternEntry).max(MAXIMUM_CRITERIA).optional(),
    mode: z.enum(['all', 'any']).optional(),
  }),
  schema: z.strictObject({
    kind: z.literal('schema'),
    description: text(),
    schema: jsonObject,
    target: z.enum(['structured-output', 'content']).optional(),
  }),
  'tool-called': z.strictObject({
    kind: z.literal('tool-called'),
    description: text(),
    tool: z.string().regex(TOOL_NAME),
    minimum: z.number().int().min(1).max(MAXIMUM_MINIMUM_CALLS).optional(),
  }),
  judge: z.strictObject({
    kind: z.literal('judge'),
    description: text(),
    model: z.string().regex(MODEL_ROW).max(256),
    rubric: text(MAXIMUM_RUBRIC_LENGTH),
  }),
} as const;

/** The definition as the catalog and a goal's record hold it: each default written out. */
const matchDefinition = z.strictObject({
  kind: z.literal('match'),
  description: text(),
  phrases: z.array(text()).max(MAXIMUM_CRITERIA),
  patterns: z.array(storedPatternEntry).max(MAXIMUM_CRITERIA),
  mode: z.enum(['all', 'any']),
});
const schemaDefinition = z.strictObject({
  kind: z.literal('schema'),
  description: text(),
  schema: jsonObject,
  target: z.enum(['structured-output', 'content']),
});
const toolCalledDefinition = z.strictObject({
  kind: z.literal('tool-called'),
  description: text(),
  tool: z.string().regex(TOOL_NAME),
  minimum: z.number().int().min(1).max(MAXIMUM_MINIMUM_CALLS),
});
const judgeDefinition = z.strictObject({
  kind: z.literal('judge'),
  description: text(),
  model: z.string().regex(MODEL_ROW).max(256),
  rubric: text(MAXIMUM_RUBRIC_LENGTH),
});

/**
 * A validator definition, canonical: every default written out. It is what the catalog keeps, what a
 * goal's record copies, and what the version is the digest of. A kind added later adds a member and
 * changes none that is here, so a record written under an earlier set of kinds still decodes.
 */
export const validatorDefinitionSchema = z.discriminatedUnion('kind', [
  matchDefinition,
  schemaDefinition,
  toolCalledDefinition,
  judgeDefinition,
]);

/** A validator definition, canonical. */
export type ValidatorFileDefinition = z.infer<typeof validatorDefinitionSchema>;

/** The version of a definition: the SHA-256, as lowercase hex, of its canonical JSON. */
export function validatorFileVersion(definition: ValidatorFileDefinition): string {
  return sha256HexSync(canonicalJson(definition));
}

/** Whether a definition's own contents are usable: its patterns and its schema compile. */
function usable(definition: ValidatorFileDefinition): ValidatorFileProblemCode | undefined {
  try {
    if (definition.kind === 'match') {
      for (const entry of definition.patterns) new RegExp(entry.pattern, entry.flags).test('');
    }
  } catch {
    return 'VALIDATOR_FILE_INVALID_PATTERN';
  }
  if (definition.kind === 'schema') {
    try {
      standardSchemaFromJsonSchema(definition.schema);
    } catch {
      return 'VALIDATOR_FILE_INVALID_SCHEMA';
    }
  }
  return undefined;
}

/**
 * A definition as a goal's record stores it, checked at the boundary that reads it: the same schema
 * a file is parsed into, so a record holds nothing a file could not. `undefined` unless it is exactly
 * a definition whose patterns and schema still compile.
 */
export function decodeStoredValidatorDefinition(
  value: unknown,
): ValidatorFileDefinition | undefined {
  const parsed = validatorDefinitionSchema.safeParse(value);
  if (!parsed.success || usable(parsed.data) !== undefined) return undefined;
  return parsed.data;
}

/** What reading a file's text answers. */
export type ParsedValidatorFile =
  | { readonly ok: true; readonly definition: ValidatorFileDefinition; readonly version: string }
  | { readonly ok: false; readonly code: ValidatorFileProblemCode };

/** What the reader knows that the file does not say. */
export interface ValidatorFileContext {
  /**
   * Whether `model` is a row of the model catalog, for a `judge` file. Left out, no model is
   * refused, which is how a Bureau with no catalog to ask reads a file.
   */
  readonly modelKnown?: ((model: string) => boolean) | undefined;
}

/** The text of a file, or `undefined` for bytes that are not UTF-8. */
export function decodeValidatorFile(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The problem a file's issues name: a regular-expression flag is a pattern problem, all else a definition one. */
function problemOfIssues(
  kind: string,
  issues: readonly z.core.$ZodIssue[],
): ValidatorFileProblemCode {
  const flagsRefused = issues.some(
    (issue) => kind === 'match' && issue.path[0] === 'patterns' && issue.path[2] === 'flags',
  );
  return flagsRefused ? 'VALIDATOR_FILE_INVALID_PATTERN' : 'VALIDATOR_FILE_INVALID_DEFINITION';
}

/** The canonical definition of a file the kind's schema accepted. */
function canonicalOf(
  file: z.infer<(typeof fileSchemas)[keyof typeof fileSchemas]>,
): ValidatorFileDefinition | undefined {
  switch (file.kind) {
    case 'match': {
      const { phrases, patterns, mode, description } = file;
      // A match with nothing to match could never fail, or never pass.
      if ((phrases?.length ?? 0) + (patterns?.length ?? 0) === 0) return undefined;
      return {
        kind: 'match',
        description,
        phrases: [...(phrases ?? [])],
        patterns: (patterns ?? []).map((entry) => ({
          pattern: entry.pattern,
          flags: entry.flags ?? 'i',
        })),
        mode: mode ?? 'all',
      };
    }
    case 'schema':
      return {
        kind: 'schema',
        description: file.description,
        schema: file.schema,
        target: file.target ?? 'structured-output',
      };
    case 'tool-called':
      return {
        kind: 'tool-called',
        description: file.description,
        tool: file.tool,
        minimum: file.minimum ?? 1,
      };
    case 'judge':
      return {
        kind: 'judge',
        description: file.description,
        model: file.model,
        rubric: file.rubric,
      };
  }
}

/**
 * Reads the file named `stem` from its text: the stem and the JSON are checked, then the definition
 * of its kind, then that what it holds compiles (each regular expression, a schema) and that a
 * judge's model is one the catalog has. Each refusal is a code, and nothing of the text.
 */
export function parseValidatorFile(
  stem: string,
  fileText: string,
  context: ValidatorFileContext = {},
): ParsedValidatorFile {
  if (!isPluginName(stem)) return { ok: false, code: 'VALIDATOR_FILE_INVALID_NAME' };
  let json: unknown;
  try {
    json = JSON.parse(fileText);
  } catch {
    return { ok: false, code: 'VALIDATOR_FILE_NOT_JSON' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, code: 'VALIDATOR_FILE_INVALID_DEFINITION' };
  }
  const kind: unknown = Reflect.get(json, 'kind');
  if (kind === 'command') return { ok: false, code: 'VALIDATOR_FILE_COMMAND_KIND' };
  if (typeof kind !== 'string') return { ok: false, code: 'VALIDATOR_FILE_INVALID_DEFINITION' };
  if (!Object.hasOwn(fileSchemas, kind)) return { ok: false, code: 'VALIDATOR_FILE_UNKNOWN_KIND' };
  const file = fileSchemas[kind as keyof typeof fileSchemas].safeParse(json);
  if (!file.success) return { ok: false, code: problemOfIssues(kind, file.error.issues) };
  const definition = canonicalOf(file.data);
  if (definition === undefined) return { ok: false, code: 'VALIDATOR_FILE_INVALID_DEFINITION' };
  const problem = usable(definition);
  if (problem !== undefined) return { ok: false, code: problem };
  if (
    definition.kind === 'judge' &&
    context.modelKnown !== undefined &&
    !context.modelKnown(definition.model)
  ) {
    return { ok: false, code: 'VALIDATOR_FILE_UNKNOWN_MODEL' };
  }
  return { ok: true, definition, version: validatorFileVersion(definition) };
}

// ---------------------------------------------------------------------------
// Running a definition
// ---------------------------------------------------------------------------

/**
 * What a definition's validator needs from the Bureau that runs it: the one thing a kind cannot
 * do alone, ask a model. `decide` is `Bureau.decisions.decide`, whose `model` option names the
 * catalog row, and whose audit record is filed under the goal run and the principal that owns it.
 */
export interface FileValidatorRuntime {
  readonly decide?:
    | ((
        request: DecisionRequest,
        options: {
          readonly principal?: string;
          readonly taskId?: string;
          readonly signal?: AbortSignal;
          readonly model?: string;
        },
      ) => Promise<Decision<unknown>>)
    | undefined;
}

/** What a judge's model answers. */
const judgeAnswer = z.strictObject({ passes: z.boolean(), missing: z.array(z.string()) });

const MAXIMUM_REPORTED_SCHEMA_ERRORS = 5;

type Executor = Validator['validate'];

function matchExecutor(
  name: string,
  definition: Extract<ValidatorFileDefinition, { kind: 'match' }>,
): Executor {
  const expressions = definition.patterns.map(
    (entry) =>
      [`/${entry.pattern}/${entry.flags}`, new RegExp(entry.pattern, entry.flags)] as const,
  );
  return ({ result }): ValidatorOutcome => {
    const answer = result.content;
    const folded = answer.toLowerCase();
    const outcomes: Array<readonly [string, boolean]> = [
      ...definition.phrases.map(
        (phrase) => [`“${phrase}”`, folded.includes(phrase.toLowerCase())] as const,
      ),
      ...expressions.map(([label, expression]) => [label, expression.test(answer)] as const),
    ];
    const matched = outcomes.filter(([, hit]) => hit).map(([label]) => label);
    const missing = outcomes.filter(([, hit]) => !hit).map(([label]) => label);
    const passes = definition.mode === 'all' ? missing.length === 0 : matched.length > 0;
    const evidence = [{ source: name, detail: { mode: definition.mode, matched, missing } }];
    return passes
      ? { kind: 'pass', evidence }
      : {
          kind: 'fail',
          feedback:
            definition.mode === 'all'
              ? `The answer is missing: ${missing.join('; ')}.`
              : `The answer holds none of: ${missing.join('; ')}.`,
          evidence,
          retryable: true,
        };
  };
}

function schemaExecutor(
  name: string,
  definition: Extract<ValidatorFileDefinition, { kind: 'schema' }>,
): Executor {
  const standard = standardSchemaFromJsonSchema(definition.schema)['~standard'];
  const fails = (feedback: string): ValidatorOutcome => ({
    kind: 'fail',
    feedback,
    evidence: [],
    retryable: true,
  });
  return ({ result }): ValidatorOutcome => {
    let value: unknown;
    if (definition.target === 'content') {
      try {
        value = JSON.parse(result.content);
      } catch {
        return fails('The answer is not JSON, so it cannot be checked against the schema.');
      }
    } else {
      value = (result as { output?: unknown }).output;
      if (value === undefined) {
        return fails('The run produced no structured output to check against the schema.');
      }
    }
    const checked = standard.validate(value);
    if (!('issues' in checked)) {
      return { kind: 'pass', evidence: [{ source: name, detail: { target: definition.target } }] };
    }
    const errors = checked.issues.map((issue) => {
      const path = (issue.path ?? []).map(String).join('.');
      return `${path === '' ? '(the whole value)' : path}: ${issue.message}`;
    });
    const shown = errors.slice(0, MAXIMUM_REPORTED_SCHEMA_ERRORS);
    return {
      kind: 'fail',
      feedback: `The ${definition.target === 'content' ? 'answer' : 'structured output'} does not satisfy the schema: ${shown.join('; ')}${
        errors.length > shown.length ? `; and ${errors.length - shown.length} more` : ''
      }.`,
      evidence: [{ source: name, detail: { target: definition.target, errors: errors.length } }],
      retryable: true,
    };
  };
}

function toolCalledExecutor(
  name: string,
  definition: Extract<ValidatorFileDefinition, { kind: 'tool-called' }>,
): Executor {
  return ({ result }): ValidatorOutcome => {
    // Only a call that succeeded counts: a call that failed, or that waits on approval, did nothing.
    let successes = 0;
    for (const step of result.steps) {
      for (const call of step.results) {
        if (call.toolName === definition.tool && call.outcome === 'success') successes += 1;
      }
    }
    const evidence = [
      {
        source: name,
        detail: { tool: definition.tool, calls: successes, minimum: definition.minimum },
      },
    ];
    return successes >= definition.minimum
      ? { kind: 'pass', evidence }
      : {
          kind: 'fail',
          feedback:
            definition.minimum === 1
              ? `The run did not call the tool "${definition.tool}" successfully.`
              : `The run called the tool "${definition.tool}" successfully ${successes} of the ${definition.minimum} times it needed.`,
          evidence,
          retryable: true,
        };
  };
}

function judgeExecutor(
  name: string,
  definition: Extract<ValidatorFileDefinition, { kind: 'judge' }>,
  runtime: FileValidatorRuntime | undefined,
): Executor {
  const refused = (code: string, message: string): ValidatorOutcome => ({
    kind: 'unavailable',
    error: { kind: 'load', code, message },
    reason: message,
  });
  return async ({ result, goalRunId, principal }, signal): Promise<ValidatorOutcome> => {
    const decide = runtime?.decide;
    if (decide === undefined) {
      return refused('VALIDATOR_JUDGE_UNAVAILABLE', 'This Bureau has no model to judge with.');
    }
    let decision: Decision<unknown>;
    try {
      decision = await decide(
        {
          kind: 'structured',
          question: `Judge the answer against this rubric. Say whether it satisfies the rubric, and when it does not, list what is missing.\n\nRubric:\n${definition.rubric}`,
          schema: judgeAnswer,
          context: result.content,
        },
        {
          taskId: goalRunId,
          model: definition.model,
          signal,
          ...(principal === undefined ? {} : { principal }),
        },
      );
    } catch (error) {
      if (signal.aborted) return { kind: 'canceled' };
      const failure = error as { readonly name?: unknown; readonly code?: unknown };
      // A model that cannot be used (not configured, forbidden by policy, no key) is the judge being
      // unavailable; an answer that did not parse, or any other failure, leaves the verdict open.
      if (failure.name === 'DecisionSchemaError') {
        return {
          kind: 'indeterminate',
          reason: 'VALIDATOR_JUDGE_ANSWER_UNPARSEABLE',
        };
      }
      if (failure.code === 'NOT_CONFIGURED' || failure.name === 'ModelPolicyDeniedError') {
        return refused('VALIDATOR_JUDGE_UNAVAILABLE', 'The judge’s model cannot be used.');
      }
      return { kind: 'indeterminate', reason: 'VALIDATOR_JUDGE_FAILED' };
    }
    const answer = judgeAnswer.safeParse(decision.value);
    if (!answer.success) {
      return { kind: 'indeterminate', reason: 'VALIDATOR_JUDGE_ANSWER_UNPARSEABLE' };
    }
    const evidence = [
      {
        source: name,
        detail: {
          model: `${decision.provider}/${decision.model}`,
          passes: answer.data.passes,
          missing: answer.data.missing,
        },
      },
    ];
    return answer.data.passes
      ? { kind: 'pass', evidence }
      : {
          kind: 'fail',
          feedback:
            answer.data.missing.length === 0
              ? 'The judge found the answer does not satisfy the rubric.'
              : answer.data.missing.join('\n'),
          evidence,
          retryable: true,
        };
  };
}

/**
 * The executable for a definition, as a goal runs it: the validator named `name` at the version the
 * definition digests to, with the evidence and feedback its kind gives. It reads only the
 * definition, so it runs the same whatever the file now says, or whether it exists. Only a `judge`
 * is stochastic, and only a `judge` needs `runtime`.
 */
export function createFileValidator(
  name: string,
  definition: ValidatorFileDefinition,
  runtime?: FileValidatorRuntime,
): Validator {
  const version = validatorFileVersion(definition);
  const executors: Record<ValidatorFileDefinition['kind'], () => Executor> = {
    match: () =>
      matchExecutor(name, definition as Extract<ValidatorFileDefinition, { kind: 'match' }>),
    schema: () =>
      schemaExecutor(name, definition as Extract<ValidatorFileDefinition, { kind: 'schema' }>),
    'tool-called': () =>
      toolCalledExecutor(
        name,
        definition as Extract<ValidatorFileDefinition, { kind: 'tool-called' }>,
      ),
    judge: () =>
      judgeExecutor(
        name,
        definition as Extract<ValidatorFileDefinition, { kind: 'judge' }>,
        runtime,
      ),
  };
  return {
    identity: { name, version },
    // A model's verdict is not evidence a goal that requires deterministic validation may accept.
    determinism: definition.kind === 'judge' ? 'stochastic' : 'deterministic',
    validate: executors[definition.kind](),
  };
}
