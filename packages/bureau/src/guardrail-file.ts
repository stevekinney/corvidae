/**
 * COR-2120 — owner-defined guardrails: a JSON file in the Bungalow's `guardrails` folder that stops
 * an agent saying, being told, or calling a tool with something the owner never wants, as data that
 * is safe to store (no code runs from it).
 *
 * ## The file
 *
 * `<bungalow>/guardrails/<name>.json`, whose stem is the guardrail's name, which an agent file lists
 * in `guardrails` by that stem. A stem holds no `:`, which a plugin's guardrails (`plugin:name`) keep
 * for themselves, so an owner's can never be a contributed one's. The file is one JSON object, closed
 * to any key not named here, and it has no version field: its version is a digest of what it says.
 *
 * - `kind`: `pattern`, the only kind.
 * - `description`: what the guardrail guards, in a sentence.
 * - `checks`: what it reads, `input` (what the user says), `output` (what the agent replies),
 *   `tool-result` (what a tool answers) or `tool-call` (the call the model makes, as the JSON text
 *   of its arguments).
 * - `action`: what it does when it matches, `block` (the default), `warn` or `tripwire`.
 * - `phrases`: text to look for, case-insensitively; `patterns`: regular expressions, compiled with
 *   the flags `iu`. At least one of them, each non-empty.
 *
 * ## Its version
 *
 * The version is the lowercase hex SHA-256 of the canonical parsed definition (every default written
 * out, keys sorted). An agent that names the guardrail folds it into its own identity, and a
 * snapshot of the agent copies the definition, so a run runs the guardrail it started with.
 *
 * ## Refusals
 *
 * A file that cannot be used is listed `invalid` with a code from {@link GUARDRAIL_FILE_PROBLEM_CODES}
 * and nothing else: an identifier, never text from the file or the regular-expression engine.
 *
 * @module guardrail-file
 */

import { sha256HexSync } from '@lostgradient/cryptography';
import type {
  PluginInputGuardrail,
  PluginOutputGuardrail,
  PluginToolGuardrail,
} from '@lostgradient/interborough-plugin';
import { z } from 'zod';

import { canonicalJson } from './canonical-json';

/** The extension a guardrail file ends in exactly. */
export const GUARDRAIL_FILE_EXTENSION = '.json';

/** The largest guardrail file read, in bytes. */
export const GUARDRAIL_FILE_SIZE_LIMIT = 64 * 1024;

/**
 * Why a guardrail file cannot be used. Each is an identifier (`^[A-Z][A-Z0-9_]{0,63}$`): the only
 * thing a refusal says.
 */
export const GUARDRAIL_FILE_PROBLEM_CODES = [
  'GUARDRAIL_FILE_TOO_LARGE',
  'GUARDRAIL_FILE_UNREADABLE',
  'GUARDRAIL_FILE_NOT_UTF8',
  /** The text is not JSON, which includes a file written only in part. */
  'GUARDRAIL_FILE_NOT_JSON',
  /** The stem holds a `:`, or is not a name an agent file can list. */
  'GUARDRAIL_FILE_INVALID_NAME',
  /** The JSON is not an object of the `pattern` kind, or holds a key or a value the kind does not take. */
  'GUARDRAIL_FILE_INVALID_DEFINITION',
  /** A regular expression does not compile. */
  'GUARDRAIL_FILE_INVALID_PATTERN',
] as const;

/** One of {@link GUARDRAIL_FILE_PROBLEM_CODES}. */
export type GuardrailFileProblemCode = (typeof GUARDRAIL_FILE_PROBLEM_CODES)[number];

/** What a guardrail file's `checks` reads. */
export const GUARDRAIL_CHECKS = ['input', 'output', 'tool-result', 'tool-call'] as const;

const MAXIMUM_CRITERIA = 64;
const MAXIMUM_CRITERION_LENGTH = 1024;
const criterion = z.string().min(1).max(MAXIMUM_CRITERION_LENGTH);

const fileSchema = z.strictObject({
  kind: z.literal('pattern'),
  description: criterion,
  checks: z.enum(GUARDRAIL_CHECKS),
  action: z.enum(['block', 'warn', 'tripwire']).optional(),
  phrases: z.array(criterion).max(MAXIMUM_CRITERIA).optional(),
  patterns: z.array(criterion).max(MAXIMUM_CRITERIA).optional(),
});

/** The definition as the catalog and an agent's snapshot hold it: each default written out. */
export const guardrailDefinitionSchema = z.strictObject({
  kind: z.literal('pattern'),
  description: criterion,
  checks: z.enum(GUARDRAIL_CHECKS),
  action: z.enum(['block', 'warn', 'tripwire']),
  phrases: z.array(criterion).max(MAXIMUM_CRITERIA),
  patterns: z.array(criterion).max(MAXIMUM_CRITERIA),
});

/** A guardrail definition, canonical. */
export type GuardrailFileDefinition = z.infer<typeof guardrailDefinitionSchema>;

/** The digest of a definition: the SHA-256, as lowercase hex, of its canonical JSON. */
export function guardrailFileDigest(definition: GuardrailFileDefinition): string {
  return sha256HexSync(canonicalJson(definition));
}

function compiles(definition: GuardrailFileDefinition): boolean {
  try {
    for (const source of definition.patterns) new RegExp(source, 'iu').test('');
    return true;
  } catch {
    return false;
  }
}

/**
 * A definition as an agent's snapshot stores it, checked where the snapshot is read: exactly a
 * definition whose patterns still compile, or `undefined`.
 */
export function decodeStoredGuardrailDefinition(
  value: unknown,
): GuardrailFileDefinition | undefined {
  const parsed = guardrailDefinitionSchema.safeParse(value);
  return parsed.success && compiles(parsed.data) ? parsed.data : undefined;
}

/** What reading a file's text answers. */
export type ParsedGuardrailFile =
  | { readonly ok: true; readonly definition: GuardrailFileDefinition; readonly digest: string }
  | { readonly ok: false; readonly code: GuardrailFileProblemCode };

/** The text of a file, or `undefined` for bytes that are not UTF-8. */
export function decodeGuardrailFile(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Reads the file named `stem` from its text. The stem may hold no `:`; the JSON is checked, then the
 * `pattern` definition, then that every regular expression compiles. Each refusal is a code.
 */
export function parseGuardrailFile(stem: string, fileText: string): ParsedGuardrailFile {
  if (stem === '' || stem.includes(':') || stem.startsWith('.') || /[\\/\0\s]/.test(stem)) {
    return { ok: false, code: 'GUARDRAIL_FILE_INVALID_NAME' };
  }
  let json: unknown;
  try {
    json = JSON.parse(fileText);
  } catch {
    return { ok: false, code: 'GUARDRAIL_FILE_NOT_JSON' };
  }
  const file = fileSchema.safeParse(json);
  if (!file.success) return { ok: false, code: 'GUARDRAIL_FILE_INVALID_DEFINITION' };
  const { description, checks, action, phrases, patterns } = file.data;
  if ((phrases?.length ?? 0) + (patterns?.length ?? 0) === 0) {
    return { ok: false, code: 'GUARDRAIL_FILE_INVALID_DEFINITION' };
  }
  const definition: GuardrailFileDefinition = {
    kind: 'pattern',
    description,
    checks,
    action: action ?? 'block',
    phrases: [...(phrases ?? [])],
    patterns: [...(patterns ?? [])],
  };
  if (!compiles(definition)) return { ok: false, code: 'GUARDRAIL_FILE_INVALID_PATTERN' };
  return { ok: true, definition, digest: guardrailFileDigest(definition) };
}

// ---------------------------------------------------------------------------
// Running a definition
// ---------------------------------------------------------------------------

/** What a guardrail the owner wrote contributes to an agent, as a plugin's guardrail does. */
export interface OwnerGuardrailEntries {
  /** `checks: 'input'` or `'tool-result'`: an input detector, with the action the file names. */
  readonly inputDetector?: {
    readonly guardrail: PluginInputGuardrail;
    readonly action: 'block' | 'warn' | 'tripwire';
  };
  /** `checks: 'output'`. */
  readonly outputValidator?: {
    readonly guardrail: PluginOutputGuardrail;
    readonly action: 'block' | 'warn' | 'tripwire';
  };
  /** `checks: 'tool-call'`. */
  readonly toolValidator?: PluginToolGuardrail;
}

/** The category a finding of an owner's guardrail carries. */
export const OWNER_GUARDRAIL_CATEGORY = 'owner-pattern';

/** A function that says whether `text` holds any phrase or matches any pattern of `definition`. */
function matcherOf(definition: GuardrailFileDefinition): (text: string) => boolean {
  const phrases = definition.phrases.map((phrase) => phrase.toLowerCase());
  const expressions = definition.patterns.map((source) => new RegExp(source, 'iu'));
  return (text) => {
    const folded = text.toLowerCase();
    return (
      phrases.some((phrase) => folded.includes(phrase)) || expressions.some((e) => e.test(text))
    );
  };
}

/**
 * The guardrail the definition builds for the agent that names it as `id`: an input detector that
 * runs on what the user says (`input`) or on what a tool answers (`tool-result`), because Operative
 * runs every input detector on both and the file says which it means; an output validator on the
 * reply; or a tool-call validator on the JSON text of a call's arguments. A match is a finding with
 * the category {@link OWNER_GUARDRAIL_CATEGORY} and confidence 1, and its detail says nothing of the
 * text it matched.
 */
export function ownerGuardrailEntries(
  id: string,
  definition: GuardrailFileDefinition,
): OwnerGuardrailEntries {
  const matches = matcherOf(definition);
  const { description, action } = definition;
  switch (definition.checks) {
    case 'input':
    case 'tool-result': {
      const provenance = definition.checks === 'input' ? 'user-input' : 'tool-result';
      return {
        inputDetector: {
          action,
          guardrail: {
            name: id,
            description,
            detect: (input, context) =>
              Promise.resolve({
                triggered: context.provenance === provenance && matches(input),
                confidence: 1,
                category: OWNER_GUARDRAIL_CATEGORY,
              }),
          },
        },
      };
    }
    case 'output':
      return {
        outputValidator: {
          action,
          guardrail: {
            name: id,
            description,
            validate: (output) =>
              Promise.resolve({
                valid: !matches(output),
                category: OWNER_GUARDRAIL_CATEGORY,
                confidence: 1,
              }),
          },
        },
      };
    case 'tool-call':
      return {
        toolValidator: {
          name: id,
          description,
          action,
          validate: (call) =>
            Promise.resolve({
              valid: !matches(JSON.stringify(call.arguments) ?? ''),
              category: OWNER_GUARDRAIL_CATEGORY,
              confidence: 1,
            }),
        },
      };
  }
}
