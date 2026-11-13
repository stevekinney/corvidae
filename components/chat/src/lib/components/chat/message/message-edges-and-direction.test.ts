import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import RetryButton from './retry-button.svelte';

const read = (relative: string): Promise<string> =>
  Bun.file(`${import.meta.dir}/${relative}`).text();

describe('glyphs meet their edges, spacing and direction', () => {
  test('the user message keeps its trailing Copy glyph on the bubble edge', async () => {
    const source = await read('chat-message.svelte');
    expect(source).toMatch(
      /\.chat-message-wrapper\[data-role='user'\] \.chat-message-line-actions \{\s*margin-inline-end: calc\(\(0\.75rem - 1\.5rem\) \/ 2\);/,
    );
  });

  test('a bubble that is only attachments insets its tile evenly, whatever sits around the tile', async () => {
    const source = await read('chat-message.svelte');
    // The body can hold an empty text part and a status row follows the tile, so the rule keys on
    // the message's own marker, never on the tile being an only or last child.
    expect(source).toContain("data-attachments-only={attachmentsOnly ? '' : undefined}");
    expect(source).toMatch(
      /\.chat-message-wrapper\[data-role='user'\] \.chat-message\[data-attachments-only\] \{\s*padding-block: var\(--cinder-space-3\);/,
    );
    expect(source).toMatch(
      /\.chat-message\[data-attachments-only\] > :global\(\.message-attachments\) \{\s*margin-top: 0;/,
    );
  });

  test('an answer that stopped short ends in a drawn, muted ellipsis that is not read or copied', async () => {
    const source = await read('chat-message.svelte');
    const rule = source.slice(source.indexOf('An answer that stopped short'));
    // The prose is rendered by a child component, so both hops into it are global.
    expect(rule).toContain('> :global(:last-child)');
    expect(rule).toContain(
      ':global(.cinder-markdown-content > :is(p, h1, h2, h3, h4, h5, h6):last-child)::after',
    );
    for (const state of ['stopped', 'failed', 'reconnecting']) {
      expect(rule).toContain(`[data-turn-state='${state}']`);
    }
    // Empty alternative text keeps the glyph out of the accessibility tree.
    expect(rule).toContain("content: '\\2026' / '';");
    expect(rule).toContain('color: var(--cinder-text-muted);');
  });

  test('message action glyphs are sized to the time beside them and sit 8px apart', async () => {
    const source = await read('chat-message.svelte');
    expect(source).toMatch(
      /\.chat-message-line :global\(\.chat-message-action-button svg\) \{\s*inline-size: 0\.75rem;\s*block-size: 0\.75rem;/,
    );
    expect(source).toMatch(/\.chat-message-line-actions \{[^}]*gap: var\(--cinder-space-2\);/);
  });

  test('the time sits at one distance under both roles, and Sources follow the prose closely', async () => {
    const source = await read('chat-message.svelte');
    expect(source).toMatch(
      /> \.chat-message\s*\+ \.chat-message-line \{\s*margin-block-start: calc\(/,
    );
    expect(source).toMatch(
      /\[data-presentation='transcript'\] > \.chat-message-sources \{\s*margin-block-start: calc\(/,
    );
  });

  test('a bubble ending in an attachment tile has the same inset below it as beside it', async () => {
    const source = await read('chat-message.svelte');
    expect(source).toMatch(
      /\.chat-message:has\(:global\(\.message-attachments:last-child\)\) \{\s*padding-block-end: var\(--cinder-space-3\);/,
    );
  });

  test('the Sources label and chevron start on the prose edge', async () => {
    const source = await read('message-sources.svelte');
    expect(source).toMatch(/margin-inline-start: calc\(\(1rem - 1\.5rem\) \/ 2\);/);
    expect(source).toMatch(/padding-inline: 0;/);
    expect(source).toContain("[data-message-direction='rtl']");
  });

  test('the step row takes the message direction', async () => {
    const source = await read('tool-call-timeline.svelte');
    expect(source).toMatch(
      /\[data-message-direction='rtl'\]\) \.chat-tool-call-timeline \{\s*direction: rtl;/,
    );
  });

  test('the icon-only Retry is the composer attachment Retry: a quiet ghost icon button', () => {
    const { container } = render(RetryButton, {
      props: { iconOnly: true, ariaLabel: 'Retry loading chart', onclick: () => {} },
    });
    const button = container.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBe('Retry loading chart');
    expect(button.getAttribute('data-cinder-variant')).toBe('ghost');
    expect(button.getAttribute('data-cinder-size')).toBe('sm');
    expect(button.hasAttribute('data-cinder-icon-only')).toBe(true);
    expect(button.hasAttribute('data-cinder-quiet')).toBe(true);
  });

  test('Attach is a 28px rounded square with the message actions ring', async () => {
    const source = await Bun.file(`${import.meta.dir}/../input/chat-input.svelte`).text();
    expect(source).toContain('class="chat-input-attach"');
    expect(source).toMatch(
      /\.chat-input-attach\) \{\s*inline-size: 1\.75rem;\s*block-size: 1\.75rem;[\s\S]*?border-radius: var\(--cinder-radius-sm\);/,
    );
    expect(source).toMatch(
      /\.chat-input-attach:focus-visible\) \{[^}]*var\(--_cinder-focus-ring-shadow\)/,
    );
  });
});
