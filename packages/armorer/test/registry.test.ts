import { createToolbox, type AnyToolbox, type AnyToolDefinition, type ToolMetadata } from '../src';
/* eslint-disable @typescript-eslint/no-deprecated -- exercises the deprecated `searchTools` on purpose, alongside `queryTools`, for registry helper coverage. */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { defineTool } from '../src/core';
import { queryTools, reindexSearchIndex, searchTools } from '../src/core/registry';
import { createTool, type CreateToolOptions } from '../src/create-tool';

const invalidEmbedding = (texts: string[]): number[][] =>
  texts.map((text) => (text.includes('query') ? [1, 0] : [NaN]));

const lengthMismatchEmbedding = (texts: string[]): number[][] =>
  texts.map((text) => (text.includes('query') ? [1, 0, 0] : [1, 0]));

const sparseEmbedding = (texts: string[]): number[][] =>
  texts.map(() => Array.from<number>({ length: 2 }));

const makeTool = (
  name: string,
  overrides: Partial<Omit<CreateToolOptions, 'metadata' | 'input' | 'execute' | 'name'>> & {
    metadata?: ToolMetadata;
  } = {},
) =>
  createTool({
    name,
    description: `${name} tool`,
    input: z.object({ value: z.number() }),
    execute: async ({ value }) => ({ value }),
    ...overrides,
  });

describe('registry helpers', () => {
  it('accepts tool, array, and iterable inputs', () => {
    const tool = makeTool('solo');

    expect(queryTools(tool).map((entry) => entry.name)).toEqual(['solo']);
    expect(queryTools([tool]).map((entry) => entry.name)).toEqual(['solo']);
    expect(queryTools(new Set([tool])).map((entry) => entry.name)).toEqual(['solo']);
  });

  it('throws on invalid query input', () => {
    expect(() => Reflect.apply(queryTools, undefined, [123])).toThrow(
      'queryTools expects a ToolQuery input',
    );
  });

  it('reindexes embeddings when configured', () => {
    let calls = 0;
    const embed = (texts: string[]) => {
      calls += 1;
      return texts.map(() => [1, 0]);
    };
    let toolbox: AnyToolbox = createToolbox([], { embed });
    toolbox = toolbox.extend(makeTool('reindex'));

    // Initial registration should have called the embedder
    expect(calls).toBe(1);

    // Reindexing with cached embeddings should not make additional calls
    // because the cached embedder returns stored results for the same texts
    reindexSearchIndex(toolbox);
    expect(calls).toBe(1);

    // Register a new tool and verify embedder is called again for new content
    toolbox = toolbox.extend(makeTool('new-tool'));
    expect(calls).toBe(2);
  });

  it('treats empty text queries as match-all', () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(makeTool('alpha'), makeTool('beta'));

    const results = queryTools(toolbox, { text: '   ' });
    expect(results.map((tool) => tool.name).toSorted()).toEqual(['alpha', 'beta']);
  });

  it('supports AND query groups', () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      makeTool('alpha', { tags: ['fast'] }),
      makeTool('beta', { tags: ['slow'] }),
    );

    const results = queryTools(toolbox, {
      and: [{ tags: { any: ['fast'] } }, { text: 'alpha' }],
    });
    expect(results.map((tool) => tool.name)).toEqual(['alpha']);
  });

  it('supports configuration and summary selection', () => {
    let toolbox: AnyToolbox = createToolbox();
    const tool = makeTool('meta', {
      tags: ['fast'],
      metadata: { tier: 'pro' },
    });
    toolbox = toolbox.extend(tool);

    const configurations = queryTools(toolbox, { select: 'configuration' });
    expect(configurations[0]?.name).toBe('meta');

    const summaries = queryTools(toolbox, {
      select: 'summary',
      includeSchema: true,
      includeToolConfiguration: true,
    });
    expect(summaries[0]?.metadata).toEqual({ tier: 'pro' });
    expect(summaries[0]?.schema).toBe(tool.input);
    expect(summaries[0]?.configuration?.name).toBe('meta');
  });

  it('supports name and configuration selections in search', () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(makeTool('alpha'), makeTool('beta'));

    const names = searchTools(toolbox, { select: 'name' });
    expect(typeof names[0]?.tool).toBe('string');

    const configurations = searchTools(toolbox, { select: 'configuration' });
    expect(configurations[0]?.tool.name).toBeDefined();
  });

  it('includes tag matches in explain details', () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(makeTool('tagged', { tags: ['fast'] }));

    const results = searchTools(toolbox, {
      rank: { tags: ['fast'] },
      explain: true,
    });

    expect(results[0]?.matches?.tags).toEqual(['fast']);
  });

  it('supports ranker exclude and match merging', () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      makeTool('keep', { tags: ['fast'], metadata: { tier: 'pro' } }),
      makeTool('skip'),
    );

    const results = searchTools(toolbox, {
      rank: { tags: ['fast'], text: 'keep' },
      explain: true,
      ranker: (tool) => {
        if (tool.name === 'skip') {
          return { score: 0, exclude: true };
        }
        return {
          score: 2,
          reasons: ['bonus'],
          matches: {
            fields: ['name'],
            tags: ['fast'],
            schemaKeys: ['value'],
            metadataKeys: ['tier'],
            embedding: { field: 'name', score: 0.8 },
          },
        };
      },
    });

    expect(results.map((match) => match.tool.name)).toEqual(['keep']);
    expect(results[0]?.matches?.tags).toContain('fast');
    expect(results[0]?.matches?.metadataKeys).toContain('tier');
  });

  it('supports numeric ranker scores and tieBreaker none', () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(makeTool('alpha'), makeTool('beta'));

    const results = searchTools(toolbox, {
      ranker: () => 1,
      tieBreaker: 'none',
    });

    expect(results).toHaveLength(2);
  });

  it('treats empty schema and tag filters as match-all', () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(makeTool('alpha'), makeTool('beta'));

    const bySchema = queryTools<AnyToolDefinition>(toolbox, { schema: { keys: [''] } });
    expect(bySchema).toHaveLength(2);

    const byAnyTags = queryTools(toolbox, { tags: { any: [''] } });
    expect(byAnyTags).toHaveLength(2);

    const byAllTags = queryTools(toolbox, { tags: { all: [''] } });
    expect(byAllTags).toHaveLength(2);
  });

  it('handles metadata filter edge cases', () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      makeTool('meta', {
        metadata: {
          flags: ['alpha', 'beta'],
          owner: 'team-core',
          score: 10,
          enabled: true,
          temp: 'hot',
        },
      }),
      makeTool('plain'),
    );

    const byFlags = queryTools(toolbox, {
      metadata: { contains: { flags: ['alpha'] } },
    });
    expect(byFlags.map((tool) => tool.name)).toEqual(['meta']);

    const byBoolean = queryTools(toolbox, {
      metadata: { contains: { enabled: 'yes' } },
    });
    expect(byBoolean).toHaveLength(0);

    const byStartsWith = queryTools(toolbox, {
      metadata: { startsWith: { owner: 'team-' } },
    });
    expect(byStartsWith.map((tool) => tool.name)).toEqual(['meta']);

    const byRangeMax = queryTools(toolbox, {
      metadata: { range: { score: { max: 5 } } },
    });
    expect(byRangeMax).toHaveLength(0);

    const byRangeNonNumber = queryTools(toolbox, {
      metadata: { range: { temp: { min: 1 } } },
    });
    expect(byRangeNonNumber).toHaveLength(0);
  });

  it('handles embedding edge cases without crashing', () => {
    let toolbox: AnyToolbox = createToolbox([], { embed: invalidEmbedding });
    toolbox = toolbox.extend(makeTool('invalid-embedding'));

    const results = searchTools(toolbox, { rank: { text: 'query' } });
    expect(results).toHaveLength(1);
  });

  it('filters tools by untrusted output risk', () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      makeTool('web-fetch', { risk: { untrustedOutput: true } }),
      makeTool('calculator', { risk: { readOnly: true } }),
      makeTool('plain'),
    );

    const untrusted = queryTools(toolbox, { risk: { untrustedOutput: true } });
    const trusted = queryTools(toolbox, { risk: { untrustedOutput: false } });

    expect(untrusted.map((tool) => tool.name)).toEqual(['web-fetch']);
    expect(trusted.map((tool) => tool.name)).toEqual(['calculator', 'plain']);
    expect(untrusted[0]?.tags).toContain('untrusted-output');
  });

  it('requires every requested risk permission', () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      makeTool('filesystem', { risk: { permissions: ['read', 'write'] } }),
      makeTool('read-only', { risk: { permissions: ['read'] } }),
      makeTool('unspecified'),
    );

    expect(
      queryTools(toolbox, { risk: { permissions: ['read', 'write'] } }).map((tool) => tool.name),
    ).toEqual(['filesystem']);
    expect(
      queryTools(toolbox, { risk: { permissions: ['execute'] } }).map((tool) => tool.name),
    ).toEqual([]);
  });

  it('generates risk tags for defineTool registration paths', () => {
    const definition = defineTool({
      name: 'document-loader',
      description: 'loads user documents',
      risk: { untrustedOutput: true },
    });

    expect(definition.tags).toContain('untrusted-output');
  });

  it('skips embedding scores when vector lengths mismatch', () => {
    let toolbox: AnyToolbox = createToolbox([], { embed: lengthMismatchEmbedding });
    toolbox = toolbox.extend(makeTool('length-mismatch'));

    const results = searchTools(toolbox, { rank: { text: 'query' } });
    expect(results).toHaveLength(1);
  });

  it('handles sparse embedding vectors', () => {
    let toolbox: AnyToolbox = createToolbox([], { embed: sparseEmbedding });
    toolbox = toolbox.extend(makeTool('sparse'));

    const results = searchTools(toolbox, { rank: { text: 'query' } });
    expect(results).toHaveLength(1);
  });
});
/* eslint-enable @typescript-eslint/no-deprecated */
