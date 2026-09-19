import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import ts from 'typescript';

const packageRoot = resolve(import.meta.dir, '..');
const imports = `
import { expectTypeOf } from 'bun:test';
import { z } from 'zod';
import { createTool, withContext } from '../src';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { normalizeToolSchema } from '../src/utilities/schema-normalization';
export const schema = z.object({ value: z.string() });
void [expectTypeOf, createTool, withContext, normalizeToolSchema];
export type Validator = StandardSchemaV1;
`;

const sources = {
  valid: `
export const tool = createTool({
  name: '  validated  ', description: 'Validates strings', input: schema,
  metadata: { owner: 'local' }, tags: ['local'] as const,
  async execute(value) {
    expectTypeOf(value).toEqualTypeOf<{ value: string }>();
    return value.value;
  },
});
expectTypeOf(tool.name).toEqualTypeOf<'validated'>();
expectTypeOf(tool.metadata.owner).toEqualTypeOf<string>();
export const defaultTool = createTool({
  name: 'default', description: 'Uses the default object schema',
  async execute(value) {
    expectTypeOf(value).toEqualTypeOf<Record<string, unknown>>();
    return Object.keys(value);
  },
});
export const contextual = withContext({ prefix: 'value:' })({
  name: 'contextual', description: 'Allows an omitted input schema',
  async execute(value, context) {
    expectTypeOf(value).toEqualTypeOf<Record<string, unknown>>();
    return context.prefix + Object.keys(value).length;
  },
});
declare const optionalSchema: typeof schema | undefined;
export const optional = createTool({
  name: 'optional', description: 'Retains both schema states', input: optionalSchema,
  async execute(value) {
    expectTypeOf(value).toEqualTypeOf<{ value: string } | Record<string, unknown>>();
    return value;
  },
});
declare const primitiveSchema: StandardSchemaV1<unknown, string | undefined>;
export const primitive = createTool({
  name: 'primitive', description: 'Receives validator output', input: primitiveSchema,
  inputSchema: { type: 'object' },
  async execute(value) {
    expectTypeOf(value).toEqualTypeOf<string | undefined>();
    return value;
  },
});
export const asynchronous = createTool({
  name: 'asynchronous', description: 'Resolves metadata', input: schema,
  metadata: Promise.resolve({ owner: 'local' }),
  async execute(value) { return value.value; },
});
expectTypeOf(asynchronous).toExtend<Promise<unknown>>();
`,
  'incompatible-callback': `
export const invalid = createTool({
  name: 'invalid', description: 'Cannot invent a callback input', input: schema,
  async execute(value: { value: number }) { return value.value; },
});
`,
  'omitted-specific-schema': `
export const invalid = createTool<typeof schema>({
  name: 'invalid', description: 'A selected schema must be supplied',
  async execute(value) { return value.value; },
});
`,
  'missing-normalizer-schema': `
export const invalid = normalizeToolSchema<typeof schema>(undefined);
`,
};

function compileContracts(): ts.Diagnostic[] {
  const configurationPath = resolve(packageRoot, 'tsconfig.json');
  const configuration = ts.readConfigFile(configurationPath, ts.sys.readFile);
  if (configuration.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configuration.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(configuration.config, ts.sys, packageRoot);
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        .join('\n'),
    );
  }
  const files = new Map(
    Object.entries(sources).map(([name, source]) => [
      resolve(import.meta.dir, `${name}.contract.ts`),
      imports + source,
    ]),
  );
  const host = ts.createCompilerHost(parsed.options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  host.getSourceFile = (filename, languageVersion, onError, shouldCreateNewSourceFile) => {
    const source = files.get(filename);
    return source === undefined
      ? originalGetSourceFile(filename, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(filename, source, languageVersion, true);
  };
  host.readFile = (filename) => files.get(filename) ?? originalReadFile(filename);
  host.fileExists = (filename) => files.has(filename) || originalFileExists(filename);
  const program = ts.createProgram([...files.keys()], { ...parsed.options, noEmit: true }, host);
  return [...ts.getPreEmitDiagnostics(program)];
}

// Compile the real public graph once before the timed assertions. Fixtures are
// virtual compiler inputs, so no intentionally invalid source is left on disk.
const diagnostics = compileContracts();
const messagesFor = (name: string) =>
  diagnostics
    .filter(
      (diagnostic) => diagnostic.file?.fileName === resolve(import.meta.dir, `${name}.contract.ts`),
    )
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));

describe('createTool schema contracts', () => {
  it('accepts the public graph and valid schema, metadata, name, and context inference', () => {
    const invalidFiles = new Set(
      Object.keys(sources)
        .filter((name) => name !== 'valid')
        .map((name) => resolve(import.meta.dir, `${name}.contract.ts`)),
    );
    const unexpected = diagnostics.filter(
      (diagnostic) => !invalidFiles.has(diagnostic.file?.fileName ?? ''),
    );
    expect(
      unexpected.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
    ).toEqual([]);
  });

  it('rejects an execute callback incompatible with its actual validator', () => {
    expect(messagesFor('incompatible-callback')).toHaveLength(1);
    expect(messagesFor('incompatible-callback').join('\n')).toContain('value: number');
  });

  it('requires an explicitly selected input schema to be present', () => {
    expect(messagesFor('omitted-specific-schema')).toHaveLength(1);
    expect(messagesFor('omitted-specific-schema').join('\n')).toContain(
      "Property 'input' is missing",
    );
  });

  it('rejects normalization without the explicitly selected schema', () => {
    expect(messagesFor('missing-normalizer-schema')).toHaveLength(1);
    expect(messagesFor('missing-normalizer-schema').join('\n')).toContain(
      "Argument of type 'undefined'",
    );
  });
});
