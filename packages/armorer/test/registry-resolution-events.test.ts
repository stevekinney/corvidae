import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createRegistry, defineTool, resolveName } from '../src';

describe('registry resolution events and suffix matching', () => {
  it('emits resolution event when tool resolved', (done) => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    let eventEmitted = false;
    const mockDispatchEvent = (event: any) => {
      if (event.type === 'name-resolved') {
        expect(event.resolvedName).toBe('read-file');
        expect(event.tier).toBe('exact');
        expect(event.originalName).toBe('read-file');
        eventEmitted = true;
      }
      return true;
    };

    const result = resolveName('read-file', registry, undefined, mockDispatchEvent);
    expect(result.resolved).toBe('read-file');
    expect(eventEmitted).toBe(true);
    done();
  });

  it('does not emit event when dispatchEvent is not provided', () => {
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
  });

  it('emits no event when resolution fails', (done) => {
    const registry = createRegistry();

    let eventEmitted = false;
    const mockDispatchEvent = () => {
      eventEmitted = true;
      return true;
    };

    const result = resolveName('nonexistent', registry, undefined, mockDispatchEvent);
    expect(result.resolved).toBeNull();
    expect(eventEmitted).toBe(false);
    done();
  });

  it('prioritizes earlier tiers over later ones', () => {
    const registry = createRegistry();
    const tool1 = defineTool({
      name: 'read-file',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    const tool2 = defineTool({
      name: 'file-reader',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool1);
    registry.register(tool2);

    // 'Read-File' matches tool1 case-insensitively, and tool2 by suffix
    // Should match tool1 because case-insensitive comes before suffix
    const result = resolveName('Read-File', registry);
    expect(result.resolved).toBe('read-file');
    expect(result.tier).toBe('case-insensitive');
  });

  it('handles complex names with many hyphens', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'my-complex-tool-name-v2',
      version: '1.0.0',
      description: 'complex',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('My_Complex_Tool_Name_V2', registry);
    expect(result.resolved).toBe('my-complex-tool-name-v2');
    expect(result.tier).toBe('normalized');
  });

  it('single character suffix match', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'send-message',
      version: '1.0.0',
      description: 'send',
      input: z.object({}),
    });
    registry.register(tool);

    const result = resolveName('e', registry);
    expect(result.resolved).toBe('send-message');
    expect(result.tier).toBe('suffix');
  });

  it('handles namespace in tool names', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'read-file',
      namespace: 'filesystem',
      version: '1.0.0',
      description: 'read',
      input: z.object({}),
    });
    registry.register(tool);

    // Note: resolveName only looks at tool names, not namespaces
    const result = resolveName('read-file', registry);
    expect(result.resolved).toBe('read-file');
  });

  it('detects ambiguous match at suffix tier', () => {
    const registry = createRegistry();
    const tool1 = defineTool({
      name: 'tool-a',
      version: '1.0.0',
      description: 'a',
      input: z.object({}),
    });
    const tool2 = defineTool({
      name: 'tool-b',
      version: '1.0.0',
      description: 'b',
      input: z.object({}),
    });
    registry.register(tool1);
    registry.register(tool2);

    const result = resolveName('tool', registry);
    expect(result.resolved).toBeNull();
    expect(result.ambiguous).toBeDefined();
    expect(result.ambiguous?.length).toBe(2);
  });

  it('returns correct tier when resolving', () => {
    const registry = createRegistry();
    const tool = defineTool({
      name: 'my-tool',
      version: '1.0.0',
      description: 'tool',
      input: z.object({}),
    });
    registry.register(tool);

    const exactResult = resolveName('my-tool', registry);
    expect(exactResult.tier).toBe('exact');

    const caseInsensitiveResult = resolveName('My-Tool', registry);
    expect(caseInsensitiveResult.tier).toBe('case-insensitive');

    const normalizedResult = resolveName('my_tool', registry);
    expect(normalizedResult.tier).toBe('normalized');

    const suffixResult = resolveName('tool', registry);
    expect(suffixResult.tier).toBe('suffix');
  });
});
