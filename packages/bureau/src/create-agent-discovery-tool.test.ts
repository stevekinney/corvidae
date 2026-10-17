import { createAgent, createMockGenerate } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createAgentCatalog } from './agent-catalog';
import { createAgentDiscoveryTool } from './create-agent-discovery-tool';

function agent(name: string) {
  return createAgent({ generate: createMockGenerate([]), name });
}

function parseDiscoveryResult(value: unknown) {
  const serialized = z.string().parse(value);
  const parsed: unknown = JSON.parse(serialized);
  return z.array(z.looseObject({ name: z.string() })).parse(parsed);
}

describe('createAgentDiscoveryTool', () => {
  it('returns every agent name when called without a search text', async () => {
    const catalog = createAgentCatalog({
      writer: agent('writer'),
      researcher: agent('researcher'),
    });
    const tool = createAgentDiscoveryTool(catalog);

    const result = parseDiscoveryResult(await tool.execute({}));

    expect(result.map((entry) => entry.name)).toEqual(['writer', 'researcher']);
  });

  it('filters case-insensitively by substring match on name', async () => {
    const catalog = createAgentCatalog({
      Writer: agent('Writer'),
      Researcher: agent('Researcher'),
    });
    const tool = createAgentDiscoveryTool(catalog);

    const result = parseDiscoveryResult(await tool.execute({ text: 'writ' }));

    expect(result.map((entry) => entry.name)).toEqual(['Writer']);
  });

  it('returns an empty array when no name matches', async () => {
    const catalog = createAgentCatalog({ writer: agent('writer') });
    const tool = createAgentDiscoveryTool(catalog);

    const result = parseDiscoveryResult(await tool.execute({ text: 'nonexistent' }));

    expect(result).toEqual([]);
  });

  it('returns an empty array for an empty catalog', async () => {
    const catalog = createAgentCatalog({});
    const tool = createAgentDiscoveryTool(catalog);

    const result = parseDiscoveryResult(await tool.execute({}));

    expect(result).toEqual([]);
  });

  it('exposes metadata only — an agent with no description or skills has exactly a name field', async () => {
    const catalog = createAgentCatalog({ writer: agent('writer') });
    const tool = createAgentDiscoveryTool(catalog);

    const result = parseDiscoveryResult(await tool.execute({}));

    expect(result).toEqual([{ name: 'writer' }]);
    expect(Object.keys(result[0]!)).toEqual(['name']);
  });

  it('never resolves a lazy agent to answer discovery — descriptors come from catalog names', async () => {
    let lazyLoaded = false;
    const catalog = createAgentCatalog({
      lazy: {
        name: '(lazy)',
        hasOutput: false,
        run: () => {
          lazyLoaded = true;
          throw new Error('the lazy agent must never load for discovery');
        },
      },
    });
    const tool = createAgentDiscoveryTool(catalog);

    const result = parseDiscoveryResult(await tool.execute({}));

    expect(result).toEqual([{ name: 'lazy' }]);
    expect(lazyLoaded).toBe(false);
  });

  describe('description and skill descriptors (COR-1301)', () => {
    const skillDescriptors = [
      {
        id: 'summarize',
        name: 'Summarize',
        description: 'Condense long documents.',
        tags: ['nlp', 'Digest'],
        inputModes: ['text/plain'],
        outputModes: ['text/markdown'],
      },
    ] as const;

    function describedCatalog() {
      return createAgentCatalog({
        writer: createAgent({
          generate: createMockGenerate([]),
          name: 'writer',
          description: 'Drafts articles.',
          skillDescriptors,
        }),
        plain: agent('plain'),
      });
    }

    it('returns the description and skill descriptors for an agent that declares them', async () => {
      const tool = createAgentDiscoveryTool(describedCatalog());

      const result = parseDiscoveryResult(await tool.execute({}));

      expect(result).toEqual([
        { name: 'writer', description: 'Drafts articles.', skillDescriptors },
        { name: 'plain' },
      ]);
    });

    it.each([
      ['description', 'ARTICLES'],
      ['skill name', 'summarize'],
      ['skill description', 'long documents'],
      ['skill tag', 'digest'],
    ])('matches case-insensitively on the %s', async (_label, text) => {
      const tool = createAgentDiscoveryTool(describedCatalog());

      const result = parseDiscoveryResult(await tool.execute({ text }));

      expect(result.map((entry) => entry.name)).toEqual(['writer']);
    });

    it('does not match text that appears in no searchable field', async () => {
      const tool = createAgentDiscoveryTool(describedCatalog());

      const result = parseDiscoveryResult(await tool.execute({ text: 'text/markdown' }));

      expect(result).toEqual([]);
    });
  });
});
