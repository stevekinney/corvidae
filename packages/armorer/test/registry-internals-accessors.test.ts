/* eslint-disable @typescript-eslint/no-deprecated -- exercises the deprecated `searchTools` on purpose for registry-internal coverage. */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AnyToolDefinition, ToolMetadata } from '../src';
import { defineTool } from '../src/core';
import type { ToolMatch } from '../src/core/registry';
import { internalRegistryTestUtilities, searchTools } from '../src/core/registry';
import { registerRegistryEmbedder, warmToolEmbeddings } from '../src/core/registry/embeddings';
import { getSchemaKeys } from '../src/core/schema-utilities';
import { type CreateToolOptions, createTool } from '../src/create-tool';

const {
  createMatchComparator,
  createToolSummary,
  getRegistryEmbeddingIndex,
  getRegistryInvertedIndex,
  getRegistryTextIndex,
  intersectFromIndex,
  isToolRegistered,
  resolveTools,
  selectMatchResults,
  selectQueryResults,
  selectTopMatches,
} = internalRegistryTestUtilities;

const constantEmbedding = (texts: string[]): number[][] => texts.map(() => [1, 0]);

const makeTool = (
  name: string,
  overrides: Partial<Omit<CreateToolOptions, 'metadata' | 'input' | 'execute' | 'name'>> & {
    metadata?: ToolMetadata;
  } = {},
) =>
  createTool({
    name,
    description: `${name} description`,
    input: z.object({ value: z.string().optional(), category: z.string().optional() }),
    execute: async (params) => params,
    ...overrides,
  });

const makeTextIndex = (tool: AnyToolDefinition) => ({
  name: tool.identity.name.toLowerCase(),
  description: tool.description.toLowerCase(),
  nameTokens: [tool.identity.name.toLowerCase()],
  descriptionTokens: tool.description.toLowerCase().split(/\s+/g).filter(Boolean),
  tags: (tool.tags ?? []).map((tag) => ({ raw: tag, normalized: tag.toLowerCase() })),
  schemaKeys: getSchemaKeys(tool.input).map((key) => ({ raw: key, normalized: key.toLowerCase() })),
  metadataKeys: Object.keys(tool.metadata ?? {}).map((key) => ({
    raw: key,
    normalized: key.toLowerCase(),
  })),
});

describe('registry internal ranking, cache, and resolver coverage', () => {
  it('covers ranking comparators, negative-score exclusion, selection fallbacks, and summary creation', () => {
    const alpha = defineTool({
      name: 'alpha-rank',
      description: 'alpha rank description',
      input: z.object({ value: z.string().optional() }),
      tags: ['fast'],
      lifecycle: { deprecated: true },
      metadata: { owner: 'team-alpha' },
      risk: { readOnly: true },
    });
    const beta = defineTool({
      name: 'beta-rank',
      description: 'beta rank description',
      input: z.object({ value: z.string().optional() }),
    });
    const matches: ToolMatch[] = [
      { tool: alpha, score: 1, reasons: [] },
      { tool: beta, score: 1, reasons: [] },
    ];

    const nameComparator = createMatchComparator('name');
    expect(nameComparator(matches[0]!, matches[1]!)).toBeLessThan(0);
    const customComparator = createMatchComparator(() => 0);
    expect(selectTopMatches([...matches], 1, customComparator)).toHaveLength(1);

    expect(
      searchTools([alpha, beta], {
        limit: 1,
        tieBreaker: () => 0,
        ranker: (tool) => (tool.name === 'alpha-rank' ? 2 : 1),
      }).map((entry) => entry.tool.name),
    ).toEqual(['alpha-rank']);
    expect(searchTools([alpha], { ranker: () => -1 })).toEqual([]);
    expect(selectMatchResults(matches, { select: 'summary' }).length).toBe(2);
    expect(Reflect.apply(selectMatchResults, undefined, [matches, { select: 'unknown' }])).toBe(
      matches,
    );
    expect(Reflect.apply(selectQueryResults, undefined, [[alpha], { select: 'unknown' }])).toEqual([
      alpha,
    ]);

    const summary = createToolSummary(alpha, true, true);
    expect(summary.deprecated).toBe(true);
    expect(summary.lifecycle?.deprecated).toBe(true);
    expect(summary.configuration?.name).toBe('alpha-rank');
    expect(summary.schema).toBe(alpha.input);
  });

  it('covers registry cache helpers and set intersection edge cases', () => {
    const alpha = makeTool('registry-alpha', { tags: ['x'] });
    const beta = makeTool('registry-beta', { tags: ['y'] });
    const registry = {
      tools: () => [alpha, beta],
      register: () => registry,
      getTool: (name: string) => (name === alpha.name ? alpha : undefined),
    };
    const tagIndex = new Map([
      ['x', new Set([alpha])],
      ['y', new Set([beta])],
    ]);

    expect(getRegistryInvertedIndex(registry, [alpha, beta])).toBe(
      getRegistryInvertedIndex(registry, [alpha, beta]),
    );
    expect(getRegistryTextIndex(registry, [alpha, beta], makeTextIndex)).toBe(
      getRegistryTextIndex(registry, [alpha, beta], makeTextIndex),
    );
    warmToolEmbeddings(alpha, constantEmbedding);
    expect(getRegistryEmbeddingIndex(registry, [alpha, beta])).toBe(
      getRegistryEmbeddingIndex(registry, [alpha, beta]),
    );
    expect(intersectFromIndex(tagIndex, [])).toEqual(new Set());
    expect(intersectFromIndex(tagIndex, ['x', 'missing'])).toEqual(new Set());
    expect(intersectFromIndex(tagIndex, ['x', 'y'])).toEqual(new Set());
    expect(isToolRegistered(registry, alpha)).toBe(true);
    expect(isToolRegistered(registry, beta)).toBe(false);
    expect(isToolRegistered({ tools: () => [alpha] }, alpha)).toBe(false);
  });

  it('covers resolveTools accessor closures across registry, tool, array, and iterable inputs', () => {
    const alpha = makeTool('resolve-alpha', {
      tags: ['x'],
      metadata: { owner: 'ops' },
    });
    const beta = makeTool('resolve-beta');
    warmToolEmbeddings(alpha, constantEmbedding);

    const registry = {
      tools: () => [alpha, beta],
      register: () => registry,
      getTool: (name: string) => (name === alpha.name ? alpha : undefined),
    };
    registerRegistryEmbedder(registry, constantEmbedding);

    const registryResolved = resolveTools(registry);
    expect(registryResolved.getInvertedIndex?.()).toBeDefined();
    expect(registryResolved.getTextIndex()).toBeDefined();
    expect(registryResolved.getEmbeddingIndex?.()).toBeDefined();

    const singleResolved = resolveTools(alpha);
    expect(singleResolved.getInvertedIndex?.()).toBeDefined();
    expect(singleResolved.getTextIndex()).toBeDefined();

    const arrayResolved = resolveTools([alpha, beta]);
    expect(arrayResolved.getInvertedIndex?.()).toBeDefined();
    expect(arrayResolved.getTextIndex()).toBeDefined();

    const iterableResolved = resolveTools(new Set([alpha, beta]));
    expect(iterableResolved.getInvertedIndex?.()).toBeDefined();
    expect(iterableResolved.getTextIndex()).toBeDefined();
  });
});
/* eslint-enable @typescript-eslint/no-deprecated */
