import { describe, expect, it } from 'bun:test';

import { parseMcpCallResult, toCallToolResult } from '../src/integrations/mcp/content';

const image = { type: 'image' as const, data: 'iVBORw0KGgo=', mimeType: 'image/png' };
const text = { type: 'text' as const, text: 'caption' };

describe('MCP content mapping', () => {
  it('keeps both blocks and structured content of a mixed result (client direction)', () => {
    expect(parseMcpCallResult({ content: [image, text], structuredContent: { width: 1 } })).toEqual(
      { content: [image, text], structuredContent: { width: 1 } },
    );
  });

  it('re-exposes a mixed result unchanged (server direction)', () => {
    const value = { content: [image, text], structuredContent: { width: 1 } };
    expect(toCallToolResult({ outcome: 'success', result: value } as never)).toEqual(value);
  });

  it('forwards the result metadata of an MCP-shaped result (server direction)', () => {
    const value = { content: [text], _meta: { 'example.com/trace': 'abc' } };
    expect(toCallToolResult({ outcome: 'success', result: value } as never)).toEqual(value);
  });

  it('round-trips ordered blocks in both directions', () => {
    const blocks = [text, image, { type: 'resource_link' as const, uri: 'file:///a', name: 'a' }];
    const parsed = parseMcpCallResult({ content: blocks });
    expect(parsed).toEqual(blocks);
    expect(toCallToolResult({ outcome: 'success', result: parsed } as never)).toEqual({
      content: blocks,
    });
  });

  it('still mirrors a plain object result as text plus structured content', () => {
    expect(
      toCallToolResult({ outcome: 'success', result: { content: 'not blocks' } } as never),
    ).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ content: 'not blocks' }, null, 2) }],
      structuredContent: { content: 'not blocks' },
    });
  });
});
