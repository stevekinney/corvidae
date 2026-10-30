/**
 * COR-1930: the `toolSources` key's checks, and the naming contract an agent file stores.
 */
import { describe, expect, test } from 'bun:test';

import { ProviderConfigurationError } from './provider-configuration-error.ts';
import { createAgentFileTools } from './seed.ts';
import {
  MAXIMUM_TOOL_NAME_LENGTH,
  NO_TOOL_SOURCES,
  parseToolSourcesConfiguration,
  qualifiedToolName,
  qualifyToolNames,
  readToolSourcesConfiguration,
  serializeToolSources,
  TOOL_NAME_SEPARATOR,
  TOOL_SOURCE_IDENTIFIER,
} from './tool-sources-configuration.ts';

const location = '/home/configuration.json';

const pets = {
  id: 'pets',
  kind: 'openapi',
  specification: { type: 'document', document: { openapi: '3.0.0', paths: {} } },
  baseUrl: 'http://127.0.0.1:9/',
};

function failureOf(work: () => unknown): ProviderConfigurationError {
  try {
    work();
  } catch (error) {
    if (error instanceof ProviderConfigurationError) return error;
    throw error;
  }
  throw new Error('Expected the configuration to be refused.');
}

describe('toolSources', () => {
  test('is none when the key or the file is absent, and round-trips what it writes', () => {
    expect(readToolSourcesConfiguration(undefined, location)).toBe(NO_TOOL_SOURCES);
    expect(readToolSourcesConfiguration('{}', location)).toBe(NO_TOOL_SOURCES);

    const parsed = parseToolSourcesConfiguration(
      [{ source: pets, tools: { 'list-pets': {} } }],
      location,
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.tools.has('list-pets')).toBe(true);
    expect(parseToolSourcesConfiguration(serializeToolSources(parsed), location)).toEqual(parsed);
  });

  test('reads acceptsSecrets per tool by its raw name, off unless true, and writes it back', () => {
    const parsed = parseToolSourcesConfiguration(
      [
        {
          source: pets,
          tools: {
            'list-pets': { acceptsSecrets: true },
            'get.pet': { acceptsSecrets: false },
            plain: {},
          },
        },
      ],
      location,
    );
    const tools = parsed[0]?.tools;
    expect(tools?.get('list-pets')?.acceptsSecrets).toBe(true);
    expect(tools?.get('get.pet')?.acceptsSecrets).toBe(false);
    expect(tools?.get('plain')?.acceptsSecrets).toBeUndefined();
    expect(parseToolSourcesConfiguration(serializeToolSources(parsed), location)).toEqual(parsed);
  });

  test('refuses what it cannot use, naming the field and never a value', () => {
    const cases: [unknown, string][] = [
      [{}, 'toolSources'],
      [[42], 'toolSources[0]'],
      // A field of the host's own spread into the entry, not kept beside the description.
      [[{ source: pets, acceptsSecrets: true }], 'toolSources[0].acceptsSecrets'],
      // A field spread into the description, which Armorer parses strictly.
      [[{ source: { ...pets, acceptsSecrets: true } }], 'toolSources[0].source'],
      [[{ source: { ...pets, id: 'Pets_1' } }], 'toolSources[0].source.id'],
      [[{ source: { ...pets, id: 'a'.repeat(21) } }], 'toolSources[0].source.id'],
      [[{ source: { ...pets, id: '1pets' } }], 'toolSources[0].source.id'],
      [[{ source: pets }, { source: pets }], 'toolSources[1].source.id'],
      [[{ source: pets, tools: [] }], 'toolSources[0].tools'],
      [[{ source: pets, tools: { 'list-pets': 1 } }], 'toolSources[0].tools.list-pets'],
      // A field no tool setting has: refused rather than ignored.
      [
        [{ source: pets, tools: { 'list-pets': { acceptsSecret: true } } }],
        'toolSources[0].tools.list-pets.acceptsSecret',
      ],
      // `acceptsSecrets` is a boolean and nothing else: a string like "false" must not read as on.
      [
        [{ source: pets, tools: { 'list-pets': { acceptsSecrets: 'false' } } }],
        'toolSources[0].tools.list-pets.acceptsSecrets',
      ],
      [
        [{ source: { ...pets, baseUrl: 'https://user:hunter2@example.com/' } }],
        'toolSources[0].source',
      ],
    ];
    for (const [value, field] of cases) {
      const failure = failureOf(() => parseToolSourcesConfiguration(value, location));
      expect(failure.field).toBe(field);
      expect(failure.message).not.toContain('hunter2');
    }
  });

  test('refuses a file that is not a JSON object', () => {
    expect(failureOf(() => readToolSourcesConfiguration('[]', location)).field).toBe('the file');
    expect(failureOf(() => readToolSourcesConfiguration('{', location)).field).toBe('the file');
  });
});

/** The `name` of a qualified tool, failing the test when it was skipped. */
function nameOf(sourceId: string, tool: string): string {
  const result = qualifiedToolName(sourceId, tool);
  if (!('name' in result)) throw new Error(`Expected ${tool} to be named.`);
  return result.name;
}

describe('the name an agent file uses for a tool', () => {
  test('is the source, two underscores, and the tool’s own name when that name is already safe', () => {
    expect(qualifiedToolName('files', 'read_file')).toEqual({ name: 'files__read_file' });
    expect(qualifiedToolName('files', 'list-pets')).toEqual({ name: 'files__list-pets' });
  });

  test('keeps the readable name and adds a digest of the raw name when a character is replaced', () => {
    const dotted = nameOf('files', 'repo.search/v2');
    expect(dotted).toMatch(/^files__repo_search_v2-[0-9a-f]{8}$/);
    // The digest is of the raw name: stable across calls, and not of the sanitized one.
    expect(nameOf('files', 'repo.search/v2')).toBe(dotted);
    expect(nameOf('files', 'repo_search_v2')).toBe('files__repo_search_v2');
  });

  test('gives `foo.bar` and `foo_bar` different names, whichever is asked about first or alone', () => {
    const underscored = nameOf('files', 'foo_bar');
    const dotted = nameOf('files', 'foo.bar');
    expect(underscored).toBe('files__foo_bar');
    expect(dotted).not.toBe(underscored);
    expect(dotted).toMatch(/^files__foo_bar-[0-9a-f]{8}$/);
    // Neither depends on the other being listed, dropped, or first.
    for (const listing of [
      ['foo_bar', 'foo.bar'],
      ['foo.bar', 'foo_bar'],
      ['foo.bar'],
      ['foo_bar'],
    ]) {
      const { named, skipped } = qualifyToolNames('files', listing);
      expect(skipped).toEqual([]);
      for (const { tool, name } of named) {
        expect(name).toBe(tool === 'foo_bar' ? underscored : dotted);
      }
    }
  });

  test('never lets a name that already looks like a digested one meet a digested name', () => {
    const lookalike = 'foo_bar-' + nameOf('files', 'foo.bar').slice(-8);
    expect(nameOf('files', lookalike)).not.toBe(`files__${lookalike}`);
    expect(nameOf('files', lookalike)).toMatch(/-[0-9a-f]{8}$/);
    expect(nameOf('files', lookalike)).not.toBe(nameOf('files', 'foo.bar'));
  });

  test('cuts a name that would pass the limit to the readable part, keeping the whole digest', () => {
    const fits = 'x'.repeat(MAXIMUM_TOOL_NAME_LENGTH - 'files__'.length);
    expect(qualifiedToolName('files', fits)).toEqual({ name: `files__${fits}` });
    const long = nameOf('files', `${fits}x`);
    expect(long.length).toBe(MAXIMUM_TOOL_NAME_LENGTH);
    expect(long).toMatch(/^files__x+-[0-9a-f]{8}$/);
    // Two long names with the same cut readable part still differ by their digest.
    expect(nameOf('files', `${fits}y`)).not.toBe(long);
    // The longest source id leaves room for a readable part.
    const longest = nameOf('a'.repeat(20), 'y'.repeat(200));
    expect(longest.length).toBe(MAXIMUM_TOOL_NAME_LENGTH);
  });

  test('cannot collide across sources, because an identifier never holds an underscore', () => {
    expect(TOOL_SOURCE_IDENTIFIER.test('a-b')).toBe(true);
    expect(TOOL_SOURCE_IDENTIFIER.test('a_b')).toBe(false);
    // Source "a" with tool "b__c" and source "a-b" with tool "c" differ, since the first `__` ends the id.
    expect(qualifiedToolName('a', 'b__c')).toEqual({ name: 'a__b__c' });
    expect(qualifiedToolName('a-b', 'c')).toEqual({ name: 'a-b__c' });
  });

  test('cannot collide with a built-in tool, none of which holds the separator', () => {
    for (const name of Object.keys(createAgentFileTools())) {
      expect(name.includes(TOOL_NAME_SEPARATOR)).toBe(false);
    }
  });

  test('skips a tool that has no name', () => {
    expect(qualifiedToolName('files', '')).toHaveProperty('skipped');
  });
});

describe('the names of all the tools a source lists', () => {
  test('are the same whatever order the server lists the tools in', () => {
    const tools = ['a.b', 'a_b', 'a b', 'plain', 'x'.repeat(80)];
    const forward = qualifyToolNames('files', tools);
    const backward = qualifyToolNames('files', [...tools].reverse());
    expect(forward.skipped).toEqual([]);
    expect(new Map(backward.named.map(({ tool, name }) => [tool, name]))).toEqual(
      new Map(forward.named.map(({ tool, name }) => [tool, name])),
    );
    expect(new Set(forward.named.map(({ name }) => name)).size).toBe(tools.length);
  });

  test('give a name two tools would share to neither, so listing order cannot choose', () => {
    // A server that lists the same name twice, and a stand-in for a digest collision.
    const repeated = qualifyToolNames('files', ['dup', 'ok', 'dup']);
    expect(repeated.named).toEqual([{ tool: 'ok', name: 'files__ok' }]);
    expect(repeated.skipped.map(({ tool }) => tool)).toEqual(['dup', 'dup']);
    const collide = (sourceId: string, tool: string) =>
      tool === 'p' || tool === 'q'
        ? { name: `${sourceId}__same` }
        : qualifiedToolName(sourceId, tool);
    for (const order of [
      ['p', 'q', 'r'],
      ['q', 'p', 'r'],
      ['r', 'q', 'p'],
    ]) {
      const result = qualifyToolNames('files', order, collide);
      expect(result.named).toEqual([{ tool: 'r', name: 'files__r' }]);
      expect(result.skipped.map(({ tool }) => tool).sort()).toEqual(['p', 'q']);
      expect(result.skipped[0]?.reason).toContain('files__same');
    }
  });

  test('report a tool with no name beside the others that load', () => {
    const result = qualifyToolNames('files', ['', 'ok']);
    expect(result.named).toEqual([{ tool: 'ok', name: 'files__ok' }]);
    expect(result.skipped).toEqual([{ tool: '', reason: 'the tool has no name.' }]);
  });
});
