import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import RetryButton from './retry-button.svelte';

const read = (relative: string): Promise<string> =>
  Bun.file(`${import.meta.dir}/${relative}`).text();

describe('glyphs meet their edges, spacing and direction', () => {
  test('the user message keeps its trailing Copy glyph on the bubble edge', async () => {
    const source = await read('chat-message.svelte');
    expect(source).toMatch(
      /\.chat-message-wrapper\[data-role='user'\] \.chat-message-line-actions \{\s*margin-inline-end: calc\(\(0\.625rem - 1\.5rem\) \/ 2\);/,
    );
  });

  test('a trailing action that has words ends on the bubble edge, not past it', async () => {
    const source = await read('chat-message.svelte');
    // The overhang above is the glyph's own inset inside its 24px box. A text action such as
    // Branch ends at its words, so the same overhang pushed it 7px past the bubble and the column.
    const rule = source.match(
      /\.chat-message-wrapper\[data-role='user'\]\s+\.chat-message-line-actions:has\(([\s\S]*?)\)\s*\{\s*margin-inline-end: 0;/,
    );
    expect(rule).not.toBeNull();
    const selector = rule?.[1]?.replace(/\s+/g, ' ') ?? '';
    expect(selector).toContain('.chat-message-action-button:last-child');
    for (const iconOnly of [
      '.chat-message-copy',
      '.chat-message-quote-button',
      '.chat-message-regenerate-button',
      '[data-cinder-icon-only]',
    ]) {
      expect(selector).toContain(iconOnly);
    }
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
      /\.chat-message-line :global\(\.chat-message-action-button svg\) \{\s*inline-size: 0\.625rem;\s*block-size: 0\.625rem;/,
    );
    expect(source).toMatch(/\.chat-message-line-actions \{[^}]*gap: var\(--cinder-space-2\);/);
  });

  test('the time sits at one distance under both roles, with no Sources row between prose and line', async () => {
    const source = await read('chat-message.svelte');
    expect(source).toMatch(
      /> \.chat-message\s*\+ \.chat-message-line \{\s*margin-block-start: var\(\s*--_cinder-chat-line-pull,\s*calc\(/,
    );
    expect(source).not.toMatch(/\[data-presentation='transcript'\] > \.chat-message-sources/);
  });

  test('a bubble ending in an attachment tile has the same inset below it as beside it', async () => {
    const source = await read('chat-message.svelte');
    expect(source).toMatch(
      /\.chat-message:has\(:global\(\.message-attachments:last-child\)\) \{\s*padding-block-end: var\(--cinder-space-3\);/,
    );
  });

  test('the Sources control ends the message line, in the size of the time, with a chevron no taller than its text', async () => {
    const source = await read('message-sources.svelte');
    const marker = /\.cinder-citation__marker\) \{[^}]*\}/.exec(source)?.[0] ?? '';
    expect(marker).toContain('margin-inline-start: auto;');
    expect(marker).toContain('font-size: inherit;');
    expect(marker).toContain('color: var(--cinder-text-muted);');
    const chevron = /\.chat-message-sources-chevron\) \{[^}]*\}/.exec(source)?.[0] ?? '';
    expect(chevron).toContain('inline-size: 0.75rem;');
    expect(chevron).toContain('block-size: 0.75rem;');
    // The control paints compact; its 44px hit area is Citation's pseudo-element, never a height.
    expect(source).not.toContain('touch-target-min');
    const message = await read('chat-message.svelte');
    expect(message).toMatch(/\.chat-message-line-sources \{\s*display: contents;/);
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
    expect(button.classList.contains('button-variant-ghost')).toBe(true);
    expect(button.classList.contains('button-size-small')).toBe(true);
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
