import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AnyToolDefinition } from '../src';
import { defineTool } from '../src/core';
import type { NormalizedTextQuery, TextSearchIndex } from '../src/core/query-predicates';
import { internalRegistryTestUtilities } from '../src/core/registry';
import type { EmbeddingInfo } from '../src/core/registry/embeddings';
import { warmToolEmbeddings } from '../src/core/registry/embeddings';
import { getSchemaKeys } from '../src/core/schema-utilities';
import { createTool } from '../src/create-tool';

const {
  buildEmbeddingIndex,
  buildTextInvertedIndex,
  collectCharIntersectionCandidates,
  collectTextCandidates,
  compileCriteria,
  createEmbeddingBucketIndex,
  createFieldTokenIndex,
  createProjectionMatrix,
  filterTools,
  getEmbeddingBandKeys,
  getEmbeddingConfiguration,
  getEmbeddingSignatureBits,
  normalizeFilterValues,
  removeToolFromEmbeddingIndex,
  riskMatches,
  selectCandidateTools,
  selectEmbeddingCandidates,
} = internalRegistryTestUtilities;

const constantEmbedding = (texts: string[]): number[][] => texts.map(() => [1, 0]);

const makeTool = (name: string) =>
  createTool({
    name,
    description: `${name} description`,
    input: z.object({
      value: z.string().optional(),
      category: z.string().optional(),
    }),
    execute: async (params) => params,
  });

const makeTextIndex = (tool: AnyToolDefinition): TextSearchIndex => ({
  name: tool.identity.name.toLowerCase(),
  description: tool.description.toLowerCase(),
  nameTokens: [tool.identity.name.toLowerCase()],
  descriptionTokens: tool.description.toLowerCase().split(/\s+/g).filter(Boolean),
  tags: (tool.tags ?? []).map((tag) => ({ raw: tag, normalized: tag.toLowerCase() })),
  schemaKeys: getSchemaKeys(tool.input).map((key) => ({
    raw: key,
    normalized: key.toLowerCase(),
  })),
  metadataKeys: Object.keys(tool.metadata ?? {}).map((key) => ({
    raw: key,
    normalized: key.toLowerCase(),
  })),
});

const makeNormalizedTextQuery = (
  overrides: Partial<NormalizedTextQuery> = {},
): NormalizedTextQuery => ({
  raw: 'alpha',
  query: 'alpha',
  mode: 'contains',
  fields: ['name', 'description', 'tags', 'schemaKeys', 'metadataKeys'],
  threshold: 0.5,
  tokens: ['alpha'],
  weights: { name: 1, description: 1, tags: 1, schemaKeys: 1, metadataKeys: 1 },
  ...overrides,
});

describe('registry internal candidate coverage', () => {
  it('covers embedding index helpers and candidate selection fallbacks', () => {
    const tool = makeTool('embed-me');
    const missingTool = makeTool('missing-embed');
    const toolWithoutEmbeddings = makeTool('still-missing');
    warmToolEmbeddings(tool, constantEmbedding);
    warmToolEmbeddings(tool, constantEmbedding);

    const indexed = buildEmbeddingIndex([tool]);
    const indexedWithMissing = buildEmbeddingIndex([tool, missingTool]);
    const missingOnly = buildEmbeddingIndex([missingTool]);
    const normalized = makeNormalizedTextQuery({
      fields: ['name'],
      weights: { name: 1, description: 0, tags: 0, schemaKeys: 0, metadataKeys: 0 },
    });
    const missingFieldQuery = makeNormalizedTextQuery({
      fields: ['metadataKeys'],
      weights: { name: 0, description: 0, tags: 0, schemaKeys: 0, metadataKeys: 1 },
    });
    const queryEmbedding: EmbeddingInfo = { vector: [1, 0], magnitude: 1 };
    const noWeightQuery = makeNormalizedTextQuery({
      fields: ['name'],
      weights: { name: 0, description: 0, tags: 0, schemaKeys: 0, metadataKeys: 0 },
    });

    expect(createProjectionMatrix(0, 4)).toEqual([]);
    expect(getEmbeddingConfiguration(32).hashBits).toBe(16);
    expect(getEmbeddingConfiguration(128).hashBits).toBe(20);
    expect(getEmbeddingConfiguration(768).hashBits).toBe(28);
    expect(getEmbeddingSignatureBits([], [1, 0])).toEqual([]);
    expect(
      Reflect.apply(getEmbeddingSignatureBits, undefined, [
        [[1, 0], undefined],
        [1, 0],
      ]),
    ).toEqual([]);
    expect(getEmbeddingBandKeys([1, 0, 1, 0], 2)).toEqual([2, 6]);
    expect(selectEmbeddingCandidates(indexed, { vector: [], magnitude: 0 }, normalized)).toBeNull();
    expect(selectEmbeddingCandidates(indexed, queryEmbedding, noWeightQuery)).toBeNull();
    expect(selectEmbeddingCandidates(missingOnly, queryEmbedding, normalized)).toEqual(
      new Set([missingTool]),
    );
    expect(selectEmbeddingCandidates(indexedWithMissing, queryEmbedding, normalized)).toEqual(
      new Set([tool, missingTool]),
    );
    expect(
      selectEmbeddingCandidates(indexedWithMissing, queryEmbedding, missingFieldQuery),
    ).toEqual(new Set([missingTool]));
    expect(
      selectEmbeddingCandidates(indexed, { vector: [-1, -1], magnitude: Math.sqrt(2) }, normalized),
    ).toBeNull();

    removeToolFromEmbeddingIndex(indexed, tool);
    removeToolFromEmbeddingIndex(indexed, toolWithoutEmbeddings);
    const bucketIndex = createEmbeddingBucketIndex(2);
    expect(bucketIndex.dimension).toBe(2);
  });

  it('covers text candidate selection branches and query predicate compilation', () => {
    const alpha = defineTool({
      name: 'alpha-tool',
      namespace: 'ops',
      version: '1.0.0',
      description: 'alpha description',
      input: z.object({
        value: z.string().optional(),
        category: z.string().optional(),
      }),
      tags: ['fast', 'read-only'],
      risk: { readOnly: true, mutates: false, dangerous: false },
      lifecycle: { deprecated: true },
      metadata: { owner: 'team-alpha', tier: 'gold', score: 5, status: 'active' },
    });
    const beta = defineTool({
      name: 'beta-tool',
      namespace: 'core',
      version: '2.0.0',
      description: 'beta description',
      input: z.object({
        value: z.string().optional(),
        category: z.string().optional(),
      }),
      tags: ['slow'],
      risk: { readOnly: false, mutates: true, dangerous: true },
      metadata: { owner: 'team-beta', flags: ['x', 'y'], status: 'archived' },
    });
    const tools = [alpha, beta];
    const textIndex = buildTextInvertedIndex(tools, makeTextIndex);

    expect(
      selectCandidateTools(tools, { tags: { any: ['missing'] } }, undefined, () => textIndex),
    ).toEqual([]);
    expect(
      selectCandidateTools(
        tools,
        { text: { query: 'be', mode: 'contains', fields: ['name'] } },
        undefined,
        () => textIndex,
      ).map((tool) => tool.name),
    ).toContain('beta-tool');
    expect(collectTextCandidates(textIndex, makeNormalizedTextQuery({ tokens: [] }))).toBeNull();
    expect(
      collectTextCandidates(
        textIndex,
        makeNormalizedTextQuery({ mode: 'fuzzy', threshold: 0, tokens: ['alpha'] }),
      ),
    ).toBeNull();
    expect(
      collectTextCandidates(
        textIndex,
        makeNormalizedTextQuery({ mode: 'fuzzy', threshold: Number.NaN, tokens: ['alpha'] }),
      ),
    ).toEqual(new Set());
    expect(
      collectTextCandidates(
        textIndex,
        makeNormalizedTextQuery({ mode: 'exact', fields: ['name'], tokens: ['alpha-tool'] }),
      ),
    ).toEqual(new Set([alpha]));
    expect(
      collectTextCandidates(
        textIndex,
        makeNormalizedTextQuery({ fields: ['name'], tokens: ['be'] }),
      ),
    ).toEqual(new Set([beta]));
    expect(
      collectTextCandidates(
        textIndex,
        makeNormalizedTextQuery({ fields: ['name'], tokens: ['a'] }),
      ),
    ).toEqual(new Set([alpha, beta]));
    expect(
      collectTextCandidates(
        textIndex,
        makeNormalizedTextQuery({ fields: ['name'], tokens: ['!!!'] }),
      ),
    ).toEqual(new Set());
    expect(
      collectTextCandidates(
        textIndex,
        makeNormalizedTextQuery({ fields: ['name'], tokens: ['!!'] }),
      ),
    ).toEqual(new Set());
    expect(collectCharIntersectionCandidates(createFieldTokenIndex(), '')).toBeNull();

    const predicate = compileCriteria({
      namespace: 'ops',
      version: '1.0.0',
      deprecated: true,
      risk: { readOnly: true, mutates: false, dangerous: false },
      metadata: { contains: { status: ['active', 'paused'] } },
    });
    expect(predicate(alpha)).toBe(true);
    expect(predicate(beta)).toBe(false);
    expect(filterTools(tools, undefined, makeTextIndex, undefined, () => textIndex)).toEqual(tools);
    expect(normalizeFilterValues('ops')).toEqual(['ops']);
    expect(riskMatches(undefined, { readOnly: true, mutates: false, dangerous: false })).toBe(
      false,
    );
    expect(
      riskMatches(
        { readOnly: true, mutates: false, dangerous: false },
        { readOnly: true, mutates: false, dangerous: false },
      ),
    ).toBe(true);
    expect(
      riskMatches({ readOnly: true, mutates: false, dangerous: false }, { readOnly: false }),
    ).toBe(false);
    expect(
      riskMatches({ readOnly: true, mutates: false, dangerous: false }, { mutates: true }),
    ).toBe(false);
    expect(
      riskMatches({ readOnly: true, mutates: false, dangerous: false }, { dangerous: true }),
    ).toBe(false);
  });
});
