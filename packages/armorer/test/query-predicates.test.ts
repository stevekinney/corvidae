import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  schemaHasKeys,
  schemaMatches,
  scoreTextMatch,
  tagsMatchAll,
  tagsMatchAny,
  tagsMatchNone,
  textMatches,
} from '../src/core/query-predicates';
import { defineTool } from '../src/core/tool-definition';

const baseTool = defineTool({
  name: 'alpha-sum',
  description: 'Handles alpha computations',
  input: z.object({
    fooId: z.string(),
    barValue: z.number().optional(),
  }),
  tags: ['alpha', 'primary'],
  metadata: {
    tier: 'premium',
    owner: 'alpha-team',
  },
});

describe('tagsMatchAny', () => {
  it('matches any provided tags and falls back to match-all when empty', () => {
    expect(tagsMatchAny(['alpha'])(baseTool)).toBe(true);
    expect(tagsMatchAny(['beta'])(baseTool)).toBe(false);
    expect(tagsMatchAny([])(baseTool)).toBe(true);
  });

  it('performs case-insensitive matching', () => {
    expect(tagsMatchAny(['ALPHA'])(baseTool)).toBe(true);
    expect(tagsMatchAny(['PRIMARY'])(baseTool)).toBe(true);
  });
});

describe('tagsMatchAll', () => {
  it('requires all tags to be present', () => {
    expect(tagsMatchAll(['alpha', 'primary'])(baseTool)).toBe(true);
    expect(tagsMatchAll(['alpha', 'missing'])(baseTool)).toBe(false);
  });

  it('returns match-all when tag list is empty', () => {
    expect(tagsMatchAll([])(baseTool)).toBe(true);
  });
});

describe('tagsMatchNone', () => {
  it('excludes tools that contain any of the tags', () => {
    expect(tagsMatchNone(['alpha'])(baseTool)).toBe(false);
    expect(tagsMatchNone(['beta'])(baseTool)).toBe(true);
  });

  it('handles tools without tags', () => {
    const noTagsTool = { ...baseTool, tags: undefined };
    expect(tagsMatchNone(['alpha'])(noTagsTool)).toBe(true);
  });

  it('returns match-all when tag list is empty', () => {
    expect(tagsMatchNone([])(baseTool)).toBe(true);
  });
});

describe('textMatches', () => {
  it('matches fuzzy text across name, description, tags, schema keys, and metadata keys', () => {
    expect(textMatches('alpha')(baseTool)).toBe(true);
    expect(textMatches('handles')(baseTool)).toBe(true);
    expect(textMatches('primary')(baseTool)).toBe(true);
    expect(textMatches('fooId')(baseTool)).toBe(true);
    expect(textMatches('tier')(baseTool)).toBe(true);
    expect(textMatches('missing')(baseTool)).toBe(false);
  });

  it('returns match-all when query is empty', () => {
    expect(textMatches('   ')(baseTool)).toBe(true);
  });

  it('supports field-restricted text queries', () => {
    expect(textMatches({ query: 'alpha', fields: ['name'] })(baseTool)).toBe(true);
    expect(textMatches({ query: 'handles', fields: ['tags'] })(baseTool)).toBe(false);
  });

  it('tokenizes queries for camelCase schema keys', () => {
    expect(textMatches({ query: 'foo id', fields: ['schemaKeys'] })(baseTool)).toBe(true);
  });

  it('matches text without diacritics', () => {
    const diacriticsTool = {
      ...baseTool,
      description: 'Cafe \u00e9lan',
    };
    expect(textMatches({ query: 'cafe', fields: ['description'] })(diacriticsTool)).toBe(true);
  });

  it('supports fuzzy matching with thresholds', () => {
    expect(textMatches({ query: 'alpa', mode: 'fuzzy', threshold: 0.6 })(baseTool)).toBe(true);
    expect(textMatches({ query: 'alpa', mode: 'fuzzy', threshold: 0.95 })(baseTool)).toBe(false);
  });

  it('supports exact matching for name and tag tokens', () => {
    const nameScore = scoreTextMatch(baseTool, {
      query: 'alpha-sum',
      mode: 'exact',
      fields: ['name'],
    });
    expect(nameScore.fields).toContain('name');
    expect(nameScore.score).toBeGreaterThan(0);

    const tagScore = scoreTextMatch(baseTool, {
      query: 'alpha',
      mode: 'exact',
      fields: ['tags'],
    });
    expect(tagScore.tagMatches).toContain('alpha');
    expect(tagScore.score).toBeGreaterThan(0);
  });

  it('returns an empty score for empty queries', () => {
    const result = scoreTextMatch(baseTool, '   ');
    expect(result).toEqual({
      score: 0,
      fields: [],
      tagMatches: [],
      schemaMatches: [],
      metadataMatches: [],
      reasons: [],
    });
  });
});

describe('schemaMatches', () => {
  it('performs loose schema comparisons', () => {
    const matching = schemaMatches(z.object({ fooId: z.string() }));
    const nonMatching = schemaMatches(z.object({ baz: z.string() }));
    expect(matching(baseTool)).toBe(true);
    expect(nonMatching(baseTool)).toBe(false);
  });
});

describe('schemaHasKeys', () => {
  it('requires all provided keys', () => {
    const predicate = schemaHasKeys(['fooId', 'barValue']);
    expect(predicate(baseTool)).toBe(true);
    expect(schemaHasKeys(['unknown'])(baseTool)).toBe(false);
  });

  it('returns match-all for empty keys', () => {
    expect(schemaHasKeys([])(baseTool)).toBe(true);
  });
});
