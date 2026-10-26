import { describe, expect, test } from 'bun:test';
import { describeToolResultPart, toolResultText } from './tool-result-text.ts';

describe('toolResultText (COR-1634)', () => {
  test('shows the content of a result without parts', () => {
    expect(toolResultText({ callId: 'c', outcome: 'success', content: { ok: true } })).toBe(
      '{\n  "ok": true\n}',
    );
  });

  test('shows ordered parts instead of the structured value beside them', () => {
    expect(
      toolResultText({
        callId: 'c',
        outcome: 'success',
        content: { series: 'sales' },
        parts: [
          { type: 'text', text: 'Here is the chart:' },
          {
            type: 'image',
            mimeType: 'image/png',
            name: 'chart.png',
            source: { kind: 'remote-url', url: 'https://tracker.example/pixel.png' },
          },
          { type: 'text', text: 'and the data.' },
        ],
      }),
    ).toBe('Here is the chart:\n\n[image: chart.png, image/png]\n\nand the data.');
  });

  test('never prints a media part’s URL, path, or bytes', () => {
    const sources = [
      { kind: 'remote-url' as const, url: 'https://tracker.example/pixel.png' },
      { kind: 'local-file' as const, path: '/etc/passwd' },
      { kind: 'inline' as const, data: 'U0VDUkVU', encoding: 'base64' as const },
    ];
    for (const source of sources) {
      const text = describeToolResultPart({ type: 'file', source });
      expect(text).toBe('[file]');
    }
  });

  test('labels a media part by alt text when it has no name', () => {
    expect(
      describeToolResultPart({
        type: 'audio',
        alt: 'A bell',
        source: { kind: 'managed-asset', assetId: 'a' },
      }),
    ).toBe('[audio: A bell]');
  });
});
