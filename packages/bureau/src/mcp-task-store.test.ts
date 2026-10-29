import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import type { MCPTaskStore } from 'armorer';
import { describe, expect, it } from 'bun:test';

/**
 * Armorer's `MCPTaskStore` is a structural subset of Weft's
 * `ConditionalTextValueStore` so a host passes `textValueStore(...)` to
 * `createMCP({ taskStore })` with no adapter. The assignment below is the
 * type test: it stops compiling if either side drifts.
 */
describe('MCPTaskStore', () => {
  it('accepts a Weft textValueStore with no adapter', async () => {
    await using storage = new MemoryStorage();
    const store: MCPTaskStore = textValueStore(storage);

    const created = await store.conditionalBatch(
      [{ key: 'mcp-task:1', expectedValue: null }],
      [{ type: 'set', key: 'mcp-task:1', value: '{}' }],
    );
    const duplicate = await store.conditionalBatch(
      [{ key: 'mcp-task:1', expectedValue: null }],
      [{ type: 'set', key: 'mcp-task:1', value: '{"again":true}' }],
    );

    expect(created).toBe(true);
    expect(duplicate).toBe(false);
    expect(await store.get('mcp-task:1')).toBe('{}');
    expect(await store.list('mcp-task:')).toEqual(['mcp-task:1']);
  });
});
