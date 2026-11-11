/**
 * COR-2276: an unclosed code fence at the end of a streaming reply renders as a streaming code
 * block, with a caret after its final character, a Writing… status, no Copy, and no raw fence text.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

// setupHappyDom() MUST run before any `@testing-library/svelte` import.
setupHappyDom();
const { render, cleanup } = await import('@testing-library/svelte');
const { default: MessageContent } = await import('./message-content.svelte');

afterEach(() => cleanup());

describe('MessageContent open fence while streaming', () => {
  test('streams the open fence inside a code block with its caret after the last character', () => {
    const { container } = render(MessageContent, {
      props: { content: 'Here is the query:\n\n```sql\nSELECT id', streaming: true },
    });

    const block = container.querySelector('.cinder-code-block');
    expect(block?.classList.contains('cinder-code-block--streaming')).toBe(true);
    const code = block?.querySelector('pre code');
    expect(code?.textContent).toBe('SELECT id');
    expect(code?.lastElementChild?.classList.contains('cinder-code-block__caret')).toBe(true);
    expect(block?.querySelector('.cinder-code-block__status')?.textContent).toBe('Writing…');
    expect(block?.querySelector('.cinder-copy-button')).toBeNull();
    // The fence line is not code and is never shown as raw text.
    expect(container.querySelector('.message-content-tail')).toBeNull();
    expect(container.textContent).not.toContain('```');
  });

  test('a fence with only its info line so far opens an empty streaming block', () => {
    const { container } = render(MessageContent, {
      props: { content: 'Query:\n\n```sql', streaming: true },
    });
    const code = container.querySelector('.cinder-code-block--streaming pre code');
    expect(code?.textContent).toBe('');
  });

  test('a streaming tail with no open fence stays raw text', () => {
    const { container } = render(MessageContent, {
      props: { content: 'First paragraph.\n\nSecond paragraph is still', streaming: true },
    });
    expect(container.querySelector('.cinder-code-block')).toBeNull();
    expect(container.querySelector('.message-content-tail')?.textContent).toContain(
      'Second paragraph is still',
    );
  });

  test('a finished message renders no streaming block', () => {
    const { container } = render(MessageContent, {
      props: { content: 'Done:\n\n```sql\nSELECT 1;\n```', streaming: false },
    });
    expect(container.querySelector('.cinder-code-block--streaming')).toBeNull();
  });
});
