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
      // A field no tool setting has yet: refused rather than ignored.
      [
        [{ source: pets, tools: { 'list-pets': { acceptsSecrets: true } } }],
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

describe('the name an agent file uses for a tool', () => {
  test('is the source, two underscores, and the tool’s own name with unsafe characters replaced', () => {
    expect(qualifiedToolName('files', 'read_file')).toEqual({ name: 'files__read_file' });
    expect(qualifiedToolName('files', 'list-pets')).toEqual({ name: 'files__list-pets' });
    expect(qualifiedToolName('files', 'repo.search/v2')).toEqual({ name: 'files__repo_search_v2' });
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

  test('skips a tool whose qualified name would exceed what a model provider allows, or that has no name', () => {
    const longest = 'x'.repeat(MAXIMUM_TOOL_NAME_LENGTH - 'files__'.length);
    expect(qualifiedToolName('files', longest)).toEqual({ name: `files__${longest}` });
    expect(qualifiedToolName('files', `${longest}x`)).toHaveProperty('skipped');
    expect(qualifiedToolName('files', '')).toHaveProperty('skipped');
  });
});
