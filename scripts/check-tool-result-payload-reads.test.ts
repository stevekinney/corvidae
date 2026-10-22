import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
  compareWithAllowlist,
  findToolResultPayloadReaders,
  readsToolResultContent,
} from './check-tool-result-payload-reads';

describe('tool-result payload readers (COR-792)', () => {
  test('counts a read of toolResult.content, or of result.content beside a tool-result type', () => {
    expect(readsToolResultContent('const value = message.toolResult?.content;')).toBe(true);
    expect(
      readsToolResultContent('function f(result: ToolResult) { return result.content; }'),
    ).toBe(true);
    expect(readsToolResultContent('const text = result.content; // a run result')).toBe(false);
    expect(readsToolResultContent('const parts = toolResult.parts;')).toBe(false);
  });

  test('reports a reader with no entry and an entry with no reader', () => {
    expect(
      compareWithAllowlist(['a.ts', 'b.ts'], { 'b.ts': 'handles parts', 'c.ts': 'gone' }),
    ).toEqual({ unlisted: ['a.ts'], stale: ['c.ts'] });
  });

  test('every current reader is listed, with how it handles parts', async () => {
    const root = join(import.meta.dir, '..');
    const allowlist = (await Bun.file(
      join(import.meta.dir, 'tool-result-payload-reads.json'),
    ).json()) as Record<string, string>;
    const result = compareWithAllowlist(await findToolResultPayloadReaders(root), allowlist);
    expect(result).toEqual({ unlisted: [], stale: [] });
    for (const reason of Object.values(allowlist)) expect(reason.length).toBeGreaterThan(20);
  });
});
