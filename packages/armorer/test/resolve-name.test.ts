import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createRegistry, defineTool, resolveName } from '../src';

describe('resolveName', () => {
  it('resolves exact match', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('read-file', registry);
    expect(result.resolved).toBe('read-file');
    expect(result.tier).toBe('exact');
  });

  it('resolves case-insensitive match', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('Read-File', registry);
    expect(result.resolved).toBe('read-file');
    expect(result.tier).toBe('case-insensitive');
  });

  it('resolves normalized match (underscores to hyphens)', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('read_file', registry);
    expect(result.resolved).toBe('read-file');
    expect(result.tier).toBe('normalized');
  });

  it('resolves normalized match (slashes to hyphens)', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('read/file', registry);
    expect(result.resolved).toBe('read-file');
    expect(result.tier).toBe('normalized');
  });

  it('resolves suffix match', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'my-read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('file', registry);
    expect(result.resolved).toBe('my-read-file');
    expect(result.tier).toBe('suffix');
  });

  it('returns null when tool not found', () => {
    const registry = createRegistry();
    const result = resolveName('nonexistent', registry);
    expect(result.resolved).toBeNull();
    expect(result.ambiguous).toBeUndefined();
  });

  it('detects ambiguity: multiple tools match case-insensitively', () => {
    const registry = createRegistry();
    const tool1 = defineTool({
      name: 'read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    const tool2 = defineTool({
      name: 'Read-File',
      version: '2.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool1);
    registry.register(tool2);

    const result = resolveName('READ_FILE', registry);
    expect(result.resolved).toBeNull();
    expect(result.ambiguous).toBeDefined();
    expect(result.ambiguous).toContain('read-file');
    expect(result.ambiguous).toContain('read-file');
  });

  it('detects ambiguity: multiple tools match suffix', () => {
    const registry = createRegistry();
    const tool1 = defineTool({
      name: 'my-read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    const tool2 = defineTool({
      name: 'your-read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool1);
    registry.register(tool2);

    const result = resolveName('read-file', registry);
    expect(result.resolved).toBeNull();
    expect(result.ambiguous).toBeDefined();
    expect(result.ambiguous?.length).toBe(2);
  });

  it('resolves single suffix match over multiple ambiguous exact matches', () => {
    const registry = createRegistry();
    const tool1 = defineTool({
      name: 'read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    const tool2 = defineTool({
      name: 'read-file',
      version: '2.0.0',
      description: 'read',
      input: z.object({}),
    });
    const tool3 = defineTool({
      name: 'write-file',
      version: '1.0.0',
      description: 'write',
      input: z.object({}),
    });
    registry.register(tool1);
    registry.register(tool2);
    registry.register(tool3);

    const result = resolveName('write-file', registry);
    expect(result.resolved).toBe('write-file');
    expect(result.tier).toBe('exact');
  });

  it('respects tier restriction: only tries allowed tiers', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'my-read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('file', registry, { restrictTo: ['exact', 'case-insensitive'] });
    expect(result.resolved).toBeNull();
  });

  it('allows suffix tier by default', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'my-read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('file', registry);
    expect(result.tier).toBe('suffix');
  });

  it('respects allowDeprecated flag', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'old-tool',
      version: '1.0.0',
      description: 'deprecated',
      lifecycle: { deprecated: true },
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('old-tool', registry, { allowDeprecated: false });
    expect(result.resolved).toBeNull();
  });

  it('allows deprecated tools when flag is true', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'old-tool',
      version: '1.0.0',
      description: 'deprecated',
      lifecycle: { deprecated: true },
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('old-tool', registry, { allowDeprecated: true });
    expect(result.resolved).toBe('old-tool');
  });

  it('handles multiple versions of the same tool', () => {
    const registry = createRegistry();
    const tool1 = defineTool({
      name: 'my-tool',
      version: '1.0.0',
      description: 'v1',
      input: z.object({}),
    });
    const tool2 = defineTool({
      name: 'my-tool',
      version: '2.0.0',
      description: 'v2',
      input: z.object({}),
    });
    registry.register(tool1);
    registry.register(tool2);

    const result = resolveName('my-tool', registry);
    expect(result.resolved).toBe('my-tool');
    expect(result.tier).toBe('exact');
  });

  it('returns empty array for ambiguous when unambiguous match found', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('read-file', registry);
    expect(result.ambiguous).toBeUndefined();
  });
});
