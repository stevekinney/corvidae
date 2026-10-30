import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createTool, createToolbox } from '../src';

function searchTool(namespace: string, version?: string) {
  return createTool({
    name: 'search',
    namespace,
    ...(version !== undefined ? { version } : {}),
    description: `Search in ${namespace}`,
    input: z.object({}),
    execute: async () => `result from ${namespace}`,
  });
}

describe('Toolbox.resolveTool', () => {
  it('reports a bare name shared by two namespaces as ambiguous and getTool as undefined', () => {
    const toolbox = createToolbox([searchTool('a', '1'), searchTool('b', '1')]);

    const resolution = toolbox.resolveTool('search');
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('expected a failed resolution');
    expect(resolution.reason).toBe('ambiguous');
    expect([...resolution.candidates].toSorted()).toEqual(['a:search@1', 'b:search@1']);
    expect(toolbox.getTool('search')).toBeUndefined();
  });

  it('keeps both same-named tools listed and reachable by id when the bare name is ambiguous', async () => {
    const toolbox = createToolbox([searchTool('a', '1'), searchTool('b', '1')]);

    expect(
      toolbox
        .tools()
        .map((tool) => tool.id)
        .toSorted(),
    ).toEqual(['a:search@1', 'b:search@1']);
    const available = await toolbox.getAvailable();
    expect(available.map((tool) => tool.id).toSorted()).toEqual(['a:search@1', 'b:search@1']);
    expect(toolbox.getTool('a:search@1')?.id).toBe('a:search@1');
    const result = await toolbox.execute({ id: 'call-1', name: 'b:search@1', arguments: {} });
    expect(result.outcome).toBe('success');
    expect(result.content).toBe('result from b');
  });

  it('does not run an ambiguous bare name', async () => {
    const toolbox = createToolbox([searchTool('a', '1'), searchTool('b', '1')]);

    const result = await toolbox.execute({ id: 'call-1', name: 'search', arguments: {} });
    expect(result.outcome).toBe('error');
    expect(result.errorCategory).toBe('not_found');
  });

  it('resolves a bare name that only one tool carries', () => {
    const toolbox = createToolbox([searchTool('a', '1')]);

    const resolution = toolbox.resolveTool('search');
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error('expected a resolved tool');
    expect(resolution.tool.id).toBe('a:search@1');
    expect(toolbox.getTool('search')).toBe(resolution.tool);
  });

  it('finds a versioned tool by namespace and name, and reports another version as a mismatch', () => {
    const toolbox = createToolbox([searchTool('a', '1')]);

    const floating = toolbox.resolveTool('a:search');
    expect(floating.ok).toBe(true);
    if (!floating.ok) throw new Error('expected a resolved tool');
    expect(floating.tool.id).toBe('a:search@1');

    const pinned = toolbox.resolveTool('a:search@1');
    expect(pinned.ok).toBe(true);

    const mismatch = toolbox.resolveTool('a:search@2');
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) throw new Error('expected a failed resolution');
    expect(mismatch.reason).toBe('version-mismatch');
    expect(mismatch.candidates).toEqual(['a:search@1']);
    expect(toolbox.getTool('a:search@2')).toBeUndefined();
  });

  it('reports a namespace that has no such tool as missing', () => {
    const toolbox = createToolbox([searchTool('a', '1')]);

    for (const missing of ['c:search', 'a:lookup', 'lookup', '']) {
      const resolution = toolbox.resolveTool(missing);
      expect(resolution).toEqual({ ok: false, reason: 'missing', candidates: [] });
      expect(toolbox.getTool(missing)).toBeUndefined();
    }
  });

  it('reports a floating reference to a namespace holding several versions as ambiguous', () => {
    const toolbox = createToolbox([searchTool('a', '1'), searchTool('a', '2')]);

    const resolution = toolbox.resolveTool('a:search');
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error('expected a failed resolution');
    expect(resolution.reason).toBe('ambiguous');
    expect([...resolution.candidates].toSorted()).toEqual(['a:search@1', 'a:search@2']);
    expect(toolbox.resolveTool('a:search@2').ok).toBe(true);
  });

  it('treats a registered name that contains a colon as a bare name', () => {
    const toolbox = createToolbox([
      createTool({
        name: 'github:search',
        description: 'Search GitHub',
        input: z.object({}),
        execute: async () => 'ok',
      }),
    ]);

    expect(toolbox.resolveTool('github:search').ok).toBe(true);
  });
});
