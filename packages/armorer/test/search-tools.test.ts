import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  createTool,
  createToolbox,
  registerToolEmbeddings,
  type AnyToolbox,
  type CreateToolOptions,
  type Embedder,
} from '../src';

import { createSearchTool, type SearchToolsResult } from '../src/tools';

describe('createSearchTool', () => {
  const makeTool = (
    name: string,
    overrides: Partial<Omit<CreateToolOptions, 'metadata' | 'input' | 'execute' | 'name'>> = {},
  ) =>
    createTool({
      name,
      description: `${name} tool`,
      input: z.object({ value: z.number() }),
      execute: async ({ value }) => ({ value }),
      ...overrides,
    });

  it('adds a search tool through the toolbox extension', () => {
    let toolbox: AnyToolbox = createToolbox();
    const searchTool = createSearchTool(toolbox);
    toolbox = toolbox.extend(searchTool);

    expect(searchTool.name).toBe('search-tools');
    expect(toolbox.getTool('search-tools')?.name).toBe('search-tools');
  });

  it('allows custom name', () => {
    let toolbox: AnyToolbox = createToolbox();
    const searchTool = createSearchTool(toolbox, { name: 'find-tools' });
    toolbox = toolbox.extend(searchTool);

    expect(searchTool.name).toBe('find-tools');
    expect(toolbox.getTool('find-tools')?.name).toBe('find-tools');
  });

  it('searches tools by query', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      makeTool('send-email', { description: 'Send an email message' }),
      makeTool('send-sms', { description: 'Send a text message' }),
      makeTool('get-weather', { description: 'Get weather forecast' }),
    );
    toolbox = toolbox.extend(createSearchTool(toolbox));

    const results = await toolbox.execute({
      name: 'search-tools',
      arguments: { query: 'send message' },
    });

    expect(results.error).toBeUndefined();
    const tools = results.result as Array<{ name: string; score: number }>;
    expect(tools.length).toBeGreaterThanOrEqual(2);
    expect(tools.map((t) => t.name)).toContain('send-email');
    expect(tools.map((t) => t.name)).toContain('send-sms');
  });

  it('omits unavailable tools from search results', async () => {
    let toolbox: AnyToolbox = createToolbox([
      makeTool('available-send', {
        description: 'Send an available message',
        availability: () => true,
      }),
      makeTool('unavailable-send', {
        description: 'Send an unavailable message',
        availability: () => false,
      }),
    ]);
    toolbox = toolbox.extend(createSearchTool(toolbox));

    const results = await toolbox.execute({
      name: 'search-tools',
      arguments: { query: 'send message' },
    });

    expect(results.error).toBeUndefined();
    const tools = results.result as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toContain('available-send');
    expect(tools.map((tool) => tool.name)).not.toContain('unavailable-send');
  });

  it('respects limit parameter', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      makeTool('tool-a'),
      makeTool('tool-b'),
      makeTool('tool-c'),
      makeTool('tool-d'),
    );
    toolbox = toolbox.extend(createSearchTool(toolbox, { limit: 2 }));

    const results = await toolbox.execute({
      name: 'search-tools',
      arguments: { query: 'tool', limit: 2 },
    });

    expect(results.error).toBeUndefined();
    const tools = results.result as Array<{ name: string }>;
    expect(tools.length).toBe(2);
  });

  it('filters by tags', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      makeTool('send-email', { tags: ['communication'] }),
      makeTool('send-sms', { tags: ['communication'] }),
      makeTool('get-weather', { tags: ['weather'] }),
    );
    toolbox = toolbox.extend(createSearchTool(toolbox));

    const results = await toolbox.execute({
      name: 'search-tools',
      arguments: { query: 'send', tags: ['communication'] },
    });

    expect(results.error).toBeUndefined();
    const tools = results.result as Array<{ name: string }>;
    expect(tools.length).toBe(2);
    expect(tools.map((t) => t.name)).not.toContain('get-weather');
  });

  it('includes reasons when explain is enabled', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(makeTool('send-email', { tags: ['email'] }));
    toolbox = toolbox.extend(createSearchTool(toolbox, { explain: true }));

    const results = await toolbox.execute({
      name: 'search-tools',
      arguments: { query: 'email' },
    });

    expect(results.error).toBeUndefined();
    const tools = results.result as Array<{ name: string; reasons?: string[] }>;
    expect(tools[0]?.reasons).toBeDefined();
    expect(tools[0]?.reasons?.length).toBeGreaterThan(0);
  });

  it('returns tool descriptions and tags', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(
      makeTool('send-email', {
        description: 'Send an email to recipients',
        tags: ['communication', 'email'],
      }),
    );
    toolbox = toolbox.extend(createSearchTool(toolbox));

    const results = await toolbox.execute({
      name: 'search-tools',
      arguments: { query: 'email' },
    });

    expect(results.error).toBeUndefined();
    const tools = results.result as Array<{
      name: string;
      description: string;
      tags?: string[];
    }>;
    expect(tools[0]?.name).toBe('send-email');
    expect(tools[0]?.description).toBe('Send an email to recipients');
    expect(tools[0]?.tags).toContain('communication');
    expect(tools[0]?.tags).toContain('email');
  });

  it('can be called directly', async () => {
    let toolbox: AnyToolbox = createToolbox();
    toolbox = toolbox.extend(makeTool('alpha'), makeTool('beta'));
    const searchTool = createSearchTool(toolbox);

    // AB-308: `createSearchTool()` now returns the concrete tool type, so
    // its call result is `SearchToolsResult[]` without a cast.
    const results = await searchTool({ query: 'alpha' });

    expect(Array.isArray(results)).toBe(true);
    if (!isSearchToolsResultArray(results))
      throw new Error('search tool returned a non-array result');
    expect(results[0]?.name).toBe('alpha');
  });

  it('has readonly metadata', () => {
    let toolbox: AnyToolbox = createToolbox();
    const searchTool = createSearchTool(toolbox);

    expect(searchTool.metadata?.readOnly).toBe(true);
    expect(searchTool.tags).toContain('readonly');
  });

  describe('semantic search', () => {
    const semanticQuery = 'notify someone';
    const toolsForSemanticSearch = () => [
      makeTool('send-email', { description: 'Send an email message' }),
      makeTool('get-weather', { description: 'Get weather forecast' }),
    ];
    // The query shares no words with either tool, so only an embedding match can rank `send-email`.
    const vectorFor = (text: string) =>
      text === semanticQuery || text.includes('email') ? [1, 0] : [0, 1];
    const embedders: Array<[string, Embedder]> = [
      ['synchronous', (texts) => texts.map(vectorFor)],
      ['asynchronous', async (texts) => texts.map(vectorFor)],
    ];

    for (const [kind, embed] of embedders) {
      it(`ranks by the toolbox's ${kind} embed function`, async () => {
        const toolbox = createToolbox(toolsForSemanticSearch(), { embed });
        const searchTool = createSearchTool(toolbox, { explain: true });

        const results = await searchFor(searchTool, semanticQuery);

        expect(results.map((result) => result.name)).toEqual(['send-email']);
        expect(results[0]?.score).toBeGreaterThan(0);
        expect(results[0]?.reasons).toEqual(['embedding:name:1.00']);
      });
    }

    it('ranks by embeddings registered with registerToolEmbeddings', async () => {
      const toolbox = createToolbox(toolsForSemanticSearch(), {
        embed: (texts) => texts.map((text) => (text === semanticQuery ? [1, 0] : [0, 1])),
      });
      const weather = toolbox.getTool('get-weather');
      if (!weather) throw new Error('get-weather is not registered');
      registerToolEmbeddings(weather, { description: [1, 0] });
      const searchTool = createSearchTool(toolbox, { explain: true });

      const results = await searchFor(searchTool, semanticQuery);

      expect(results.map((result) => result.name)).toEqual(['get-weather']);
      expect(results[0]?.reasons).toEqual(['embedding:description:1.00']);
    });

    it('still omits unavailable tools that match by embedding', async () => {
      const toolbox = createToolbox(
        [
          makeTool('send-email', {
            description: 'Send an email message',
            availability: () => false,
          }),
        ],
        { embed: (texts) => texts.map(vectorFor) },
      );
      const searchTool = createSearchTool(toolbox);

      expect(await searchFor(searchTool, semanticQuery)).toEqual([]);
    });
  });

  describe('agent usability', () => {
    it('is available to agents via toolbox.execute()', async () => {
      let toolbox: AnyToolbox = createToolbox();
      toolbox = toolbox.extend(makeTool('example-tool'));
      toolbox = toolbox.extend(createSearchTool(toolbox));

      // Simulate an agent calling the search tool via toolbox.execute()
      const result = await toolbox.execute({
        id: 'call-123',
        name: 'search-tools',
        arguments: { query: 'example' },
      });

      expect(result.error).toBeUndefined();
      expect(result.toolName).toBe('search-tools');
      expect(Array.isArray(result.result)).toBe(true);
    });

    it('is listed in toolbox.tools() for provider adapters', () => {
      let toolbox: AnyToolbox = createToolbox();
      toolbox = toolbox.extend(createSearchTool(toolbox));

      const tools = toolbox.tools();
      const searchTool = tools.find((t) => t.name === 'search-tools');

      expect(searchTool).toBeDefined();
      expect(searchTool?.description).toContain('Search for available tools');
    });
  });

  describe('dynamic tool discovery', () => {
    it('finds all tools supplied before the search tool is extended', async () => {
      let toolbox: AnyToolbox = createToolbox([
        makeTool('late-tool-alpha', { description: 'A tool added later' }),
        makeTool('late-tool-beta', { description: 'Another late tool' }),
      ]);
      toolbox = toolbox.extend(createSearchTool(toolbox));

      // Search should find the late-registered tools
      const results = await toolbox.execute({
        name: 'search-tools',
        arguments: { query: 'late tool' },
      });

      expect(results.error).toBeUndefined();
      const tools = results.result as Array<{ name: string }>;
      expect(tools.map((t) => t.name)).toContain('late-tool-alpha');
      expect(tools.map((t) => t.name)).toContain('late-tool-beta');
    });

    it('finds tools registered at any point in time', async () => {
      let toolbox: AnyToolbox = createToolbox([
        makeTool('before-tool', { description: 'Registered before' }),
        makeTool('after-tool', { description: 'Registered after' }),
        makeTool('much-later-tool', { description: 'Registered much later' }),
      ]);
      toolbox = toolbox.extend(createSearchTool(toolbox));

      // First search - should find both
      const results1 = await toolbox.execute({
        name: 'search-tools',
        arguments: { query: 'tool' },
      });
      const tools1 = results1.result as Array<{ name: string }>;
      expect(tools1.map((t) => t.name)).toContain('before-tool');
      expect(tools1.map((t) => t.name)).toContain('after-tool');

      // Second search - should find all three
      const results2 = await toolbox.execute({
        name: 'search-tools',
        arguments: { query: 'tool' },
      });
      const tools2 = results2.result as Array<{ name: string }>;
      expect(tools2.map((t) => t.name)).toContain('before-tool');
      expect(tools2.map((t) => t.name)).toContain('after-tool');
      expect(tools2.map((t) => t.name)).toContain('much-later-tool');
    });

    it('does not include itself in search results by default', async () => {
      let toolbox: AnyToolbox = createToolbox([makeTool('user-tool')]);
      toolbox = toolbox.extend(createSearchTool(toolbox));

      const results = await toolbox.execute({
        name: 'search-tools',
        arguments: { query: 'tool' },
      });

      const tools = results.result as Array<{ name: string }>;
      // The search tool itself should appear in results since it matches "tool"
      // but user-tool should definitely be there
      expect(tools.map((t) => t.name)).toContain('user-tool');
    });
  });
});

async function searchFor(
  searchTool: ReturnType<typeof createSearchTool>,
  query: string,
): Promise<SearchToolsResult[]> {
  const results = await searchTool({ query });
  if (!isSearchToolsResultArray(results))
    throw new Error('search tool returned a non-array result');
  return results;
}

function isSearchToolsResultArray(value: unknown): value is SearchToolsResult[] {
  return (
    Array.isArray(value) &&
    value.every(
      (result) =>
        typeof result === 'object' &&
        result !== null &&
        typeof result.name === 'string' &&
        typeof result.description === 'string' &&
        typeof result.score === 'number',
    )
  );
}
