import { createAgent, createLazyAgent, createMockGenerate } from '@lostgradient/operative';
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

  it('never resolves a lazy agent to answer discovery — metadata is supplied to createLazyAgent, not read from the loaded agent', async () => {
    let loaderCalls = 0;
    const skillDescriptors = [
      { id: 'translate', name: 'Translate', description: 'Renders text.', tags: ['i18n'] },
    ];
    const lazy = createLazyAgent(
      () => {
        loaderCalls += 1;
        throw new Error('the lazy agent must never load for discovery');
      },
      { label: 'lazy-label', description: 'Translates between languages.', skillDescriptors },
    );
    const catalog = createAgentCatalog({ lazy });
    const tool = createAgentDiscoveryTool(catalog);

    const unfiltered = parseDiscoveryResult(await tool.execute({}));
    const matched = parseDiscoveryResult(await tool.execute({ text: 'BETWEEN LANGUAGES' }));
    const matchedByTag = parseDiscoveryResult(await tool.execute({ text: 'i18n' }));

    expect(unfiltered).toEqual([
      { name: 'lazy', description: 'Translates between languages.', skillDescriptors },
    ]);
    expect(matched.map((entry) => entry.name)).toEqual(['lazy']);
    expect(matchedByTag.map((entry) => entry.name)).toEqual(['lazy']);
    expect(loaderCalls).toBe(0);
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

    it('skips a malformed descriptor instead of failing discovery for the whole catalog', async () => {
      const malformed = {
        ...agent('broken'),
        skillDescriptors: [{ id: 'x', name: 'Broken', description: 'No tags here.' }] as never,
      };
      const tool = createAgentDiscoveryTool(
        createAgentCatalog({ broken: malformed, writer: describedCatalog().get('writer') }),
      );

      const bySkillName = parseDiscoveryResult(await tool.execute({ text: 'broken' }));
      const byOtherAgentTag = parseDiscoveryResult(await tool.execute({ text: 'digest' }));

      expect(bySkillName.map((entry) => entry.name)).toEqual(['broken']);
      expect(byOtherAgentTag.map((entry) => entry.name)).toEqual(['writer']);
    });

    it('does not match text that appears in no searchable field', async () => {
      const tool = createAgentDiscoveryTool(describedCatalog());

      const result = parseDiscoveryResult(await tool.execute({ text: 'text/markdown' }));

      expect(result).toEqual([]);
    });
  });
});
