/**
 * Tests for tool-result-part.svelte (COR-1634): a result with ordered parts renders those parts,
 * not the structured value beside them, and never a media part's URL or bytes.
 */

/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import type { ToolResultMessagePart } from '../../utilities/types.ts';

setupHappyDom();

const { render, cleanup } = await import('@testing-library/svelte');
const { default: ToolResultPart } = await import('./tool-result-part.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function resultPart(result: ToolResultMessagePart['result']): ToolResultMessagePart {
  return { type: 'tool-result', key: 'm1:tool-result:c1', result };
}

describe('tool-result-part', () => {
  test('renders the content of a result without parts', () => {
    const { container } = render(ToolResultPart, {
      props: { part: resultPart({ callId: 'c1', outcome: 'success', content: 'plain output' }) },
    });
    expect(container.textContent).toContain('plain output');
  });

  test('renders the parts of a result, with a label for media and no URL', () => {
    const { container } = render(ToolResultPart, {
      props: {
        part: resultPart({
          callId: 'c1',
          outcome: 'success',
          content: null,
          parts: [
            { type: 'text', text: 'The snapshot:' },
            {
              type: 'image',
              mimeType: 'image/png',
              source: { kind: 'remote-url', url: 'https://tracker.example/pixel.png' },
            },
          ],
        }),
      },
    });
    const text = container.textContent ?? '';
    expect(text).toContain('The snapshot:');
    expect(text).toContain('[image: image/png]');
    expect(text).not.toContain('tracker.example');
  });
});
