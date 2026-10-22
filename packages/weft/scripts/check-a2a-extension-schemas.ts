/**
 * Checks the JSON Schemas and examples in Weft's A2A extension specifications.
 *
 * Each specification under `documentation/a2a/extensions/` embeds its schemas and examples
 * as `json` fences introduced by an HTML comment marker (the convention is stated at the
 * top of every specification):
 *
 * - `<!-- schema: <name> -->` makes the next `json` fence a JSON Schema named `<name>`.
 * - `<!-- example: <name> at <pointer> -->` makes the next `json` fence an example document;
 *   the value at the JSON Pointer `<pointer>` (RFC 6901; `{uri}` stands for the
 *   specification's own URI, escaped as one pointer segment; an empty pointer is the whole
 *   document) must validate against schema `<name>` of the same specification.
 *
 * Every schema must compile under JSON Schema draft 2020-12 (Ajv's strict mode), every
 * example must validate, every pointer must resolve, and every specification must hold at
 * least one schema and one example and state its own URI.
 *
 * @module scripts/check-a2a-extension-schemas
 */

import { join } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';

/** The base every extension URI starts with. */
export const EXTENSION_URI_BASE =
  'https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/';

/** The specification files, by name. */
export const EXTENSION_SPECIFICATIONS = [
  'durable-history-v1.md',
  'command-receipts-v1.md',
  'cleanup-v1.md',
] as const;

/** One specification's file name and Markdown text. */
export interface SpecificationInput {
  readonly name: string;
  readonly text: string;
}

interface SchemaBlock {
  readonly name: string;
  readonly body: string;
  readonly line: number;
}

interface ExampleBlock {
  readonly schemaName: string;
  readonly pointer: string;
  readonly body: string;
  readonly line: number;
}

interface ExtractedBlocks {
  readonly schemas: SchemaBlock[];
  readonly examples: ExampleBlock[];
  readonly problems: string[];
}

const SCHEMA_MARKER = /^<!--\s*schema:\s*(\S+)\s*-->\s*$/;
const EXAMPLE_MARKER = /^<!--\s*example:\s*(\S+)\s+at\s+(\S*)\s*-->\s*$/;
const ANY_MARKER = /^<!--\s*(schema|example):/;
const JSON_FENCE_OPEN = /^```json\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

/** Reads the fence that follows the marker on `markerIndex`, or reports why there is none. */
function readFence(
  lines: readonly string[],
  markerIndex: number,
): { body: string; end: number } | string {
  let open = markerIndex + 1;
  while (open < lines.length && (lines[open] ?? '').trim() === '') open += 1;
  if (!JSON_FENCE_OPEN.test(lines[open] ?? '')) return 'the marker is not followed by a json fence';
  let close = open + 1;
  while (close < lines.length && !FENCE_CLOSE.test(lines[close] ?? '')) close += 1;
  if (close >= lines.length) return 'the json fence is never closed';
  return { body: lines.slice(open + 1, close).join('\n'), end: close };
}

function extractBlocks(text: string): ExtractedBlocks {
  const lines = text.split('\n');
  const schemas: SchemaBlock[] = [];
  const examples: ExampleBlock[] = [];
  const problems: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!ANY_MARKER.test(line)) continue;
    const schemaMatch = SCHEMA_MARKER.exec(line);
    const exampleMatch = EXAMPLE_MARKER.exec(line);
    if (schemaMatch === null && exampleMatch === null) {
      problems.push(`line ${index + 1}: malformed marker ${JSON.stringify(line)}`);
      continue;
    }
    const fence = readFence(lines, index);
    if (typeof fence === 'string') {
      problems.push(`line ${index + 1}: ${fence}`);
      continue;
    }
    if (schemaMatch !== null) {
      schemas.push({ name: schemaMatch[1] ?? '', body: fence.body, line: index + 1 });
    } else if (exampleMatch !== null) {
      examples.push({
        schemaName: exampleMatch[1] ?? '',
        pointer: exampleMatch[2] ?? '',
        body: fence.body,
        line: index + 1,
      });
    }
    index = fence.end;
  }
  return { schemas, examples, problems };
}

/** Parses JSON, returning the error message instead of throwing. */
function parseJson(body: string): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(body) as unknown };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function escapePointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Resolves an RFC 6901 JSON Pointer; `found: false` means it resolves to nothing. */
function resolvePointer(document: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === '') return { found: true, value: document };
  if (!pointer.startsWith('/')) return { found: false };
  let current: unknown = document;
  for (const raw of pointer.slice(1).split('/')) {
    const segment = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      const position = /^(0|[1-9]\d*)$/.test(segment) ? Number(segment) : -1;
      if (position < 0 || position >= current.length) return { found: false };
      current = current[position];
    } else if (typeof current === 'object' && current !== null) {
      if (!Object.hasOwn(current, segment)) return { found: false };
      current = (current as Record<string, unknown>)[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

type Validator = ReturnType<InstanceType<typeof Ajv2020>['compile']>;

function compileSchemas(
  name: string,
  schemas: readonly SchemaBlock[],
  problems: string[],
): Map<string, Validator> {
  const ajv = new Ajv2020({
    strict: true,
    strictRequired: false,
    strictTypes: false,
    allErrors: true,
  });
  const compiled = new Map<string, Validator>();
  for (const block of schemas) {
    const where = `${name}: schema "${block.name}" (line ${block.line})`;
    const parsed = parseJson(block.body);
    if ('error' in parsed) {
      problems.push(`${where} is not valid JSON: ${parsed.error}`);
    } else if (compiled.has(block.name)) {
      problems.push(`${where} duplicates an earlier schema name`);
    } else if ((parsed.value as { $schema?: unknown } | null)?.$schema !== DRAFT_2020_12) {
      problems.push(`${where} must declare "$schema": "${DRAFT_2020_12}"`);
    } else {
      try {
        compiled.set(block.name, ajv.compile(parsed.value as object));
      } catch (error) {
        problems.push(`${where} does not compile: ${(error as Error).message}`);
      }
    }
  }
  return compiled;
}

function checkExample(
  name: string,
  block: ExampleBlock,
  compiled: ReadonlyMap<string, Validator>,
  problems: string[],
): void {
  const where = `${name}: example for "${block.schemaName}" at "${block.pointer}" (line ${block.line})`;
  const validate = compiled.get(block.schemaName);
  if (validate === undefined) {
    problems.push(`${where} names a schema that does not exist or did not compile`);
    return;
  }
  const parsed = parseJson(block.body);
  if ('error' in parsed) {
    problems.push(`${where} is not valid JSON: ${parsed.error}`);
    return;
  }
  const uri = `${EXTENSION_URI_BASE}${name}`;
  const pointer = block.pointer.replaceAll('{uri}', escapePointerSegment(uri));
  const resolved = resolvePointer(parsed.value, pointer);
  if (!resolved.found) {
    problems.push(`${where}: the pointer resolves to nothing`);
  } else if (!validate(resolved.value)) {
    const detail = (validate.errors ?? [])
      .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
      .join('; ');
    problems.push(`${where} fails its schema: ${detail}`);
  }
}

/** Checks one specification and returns its problems; an empty list means it passes. */
export function checkSpecification(input: SpecificationInput): string[] {
  const { name, text } = input;
  const { schemas, examples, problems } = extractBlocks(text);
  const uri = `${EXTENSION_URI_BASE}${name}`;
  if (!text.includes(uri)) problems.push(`${name}: the specification never states its URI ${uri}`);
  if (schemas.length === 0) problems.push(`${name}: no schema block (<!-- schema: name -->)`);
  if (examples.length === 0) {
    problems.push(`${name}: no example block (<!-- example: name at /pointer -->)`);
  }
  const compiled = compileSchemas(name, schemas, problems);
  for (const example of examples) checkExample(name, example, compiled, problems);
  return problems;
}

/** Checks every given specification and returns all problems, in input order. */
export function checkSpecifications(inputs: readonly SpecificationInput[]): string[] {
  return inputs.flatMap((input) => checkSpecification(input));
}

/** Reads one specification's Markdown by file name. */
export type SpecificationReader = (name: string) => Promise<string>;

const SPECIFICATION_DIRECTORY = join(import.meta.dir, '..', 'documentation', 'a2a', 'extensions');

/** Reads a specification from `documentation/a2a/extensions/`. */
export const readSpecification: SpecificationReader = (name) =>
  Bun.file(join(SPECIFICATION_DIRECTORY, name)).text();

/** Runs the check over the specifications and prints the outcome; returns the exit code. */
export async function runCli(read: SpecificationReader = readSpecification): Promise<number> {
  const inputs: SpecificationInput[] = [];
  for (const name of EXTENSION_SPECIFICATIONS) {
    inputs.push({ name, text: await read(name) });
  }
  const problems = checkSpecifications(inputs);
  if (problems.length > 0) {
    console.error('A2A extension specification check failed:');
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(
    `A2A extension specifications: ${inputs.length} documents, all schemas and examples valid.`,
  );
  return 0;
}

if (import.meta.main) process.exit(await runCli());
