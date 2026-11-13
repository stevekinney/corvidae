/**
 * The shared entry frame: a long title ends in an ellipsis while the status beside it, such as
 * "3 steps", is never cut. The label reserves room for the status by its length, so the status
 * stays whole at a phone's width.
 */

/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, fireEvent, cleanup } = await import('@testing-library/svelte');
const { default: EntryFrame } = await import('./entry-frame.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const body = createRawSnippet(() => ({ render: () => '<p>Body</p>' }));

describe('EntryFrame status', () => {
  test('tells the label how long the status is so the label can stop short of it', () => {
    const { container } = render(EntryFrame, {
      props: { id: 'frame-status', label: 'Steps', status: '3 steps', children: body },
    });

    const shell = container.querySelector<HTMLElement>('.chat-entry-frame-shell');
    expect(shell?.getAttribute('style')).toContain('--_chat-entry-frame-status-length: 7');
    expect(container.querySelector('.chat-entry-frame__status')?.textContent).toBe('3 steps');
  });

  test('reserves nothing when there is no status', () => {
    const { container } = render(EntryFrame, {
      props: { id: 'frame-quiet', label: 'Steps', children: body },
    });

    expect(container.querySelector('.chat-entry-frame-shell')?.getAttribute('style')).toBeNull();
    expect(container.querySelector('.chat-entry-frame__status')).toBeNull();
  });

  test('forwards the flat variant and leaves the frame unboxed', () => {
    const { container } = render(EntryFrame, {
      props: { id: 'frame-flat', label: 'Thinking', variant: 'flat', children: body },
    });

    const frame = container.querySelector('.chat-entry-frame');
    expect(frame?.getAttribute('data-cinder-variant')).toBe('flat');
  });

  test('uses a leading chevron that points right, then down when expanded', async () => {
    const { container } = render(EntryFrame, {
      props: { id: 'frame-chevron', label: 'Thinking', children: body },
    });

    const frame = container.querySelector<HTMLElement>('.chat-entry-frame');
    const trigger = container.querySelector<HTMLButtonElement>('.cinder-collapsible__trigger');
    expect(frame?.getAttribute('data-cinder-chevron')).toBe('start');
    expect(trigger?.firstElementChild?.classList.contains('cinder-collapsible__chevron')).toBe(
      true,
    );
    expect(trigger?.querySelector('.cinder-collapsible__label')).not.toBeNull();
    expect(trigger?.lastElementChild?.classList.contains('cinder-collapsible__label')).toBe(true);

    await fireEvent.click(trigger!);
    expect(frame?.hasAttribute('data-cinder-expanded')).toBe(true);
  });

  test('truncates the title and keeps the status on one line in the stylesheet', async () => {
    const source = await Bun.file(new URL('./entry-frame.svelte', import.meta.url)).text();

    expect(source).toMatch(/\.chat-entry-frame__status \{[^}]*white-space: nowrap;/);
    expect(source).toMatch(
      /:global\(\.cinder-collapsible__label\) \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/,
    );
    expect(source).toMatch(
      /:has\(\.chat-entry-frame__status\) :global\(\.cinder-collapsible__trigger\) \{\s*padding-inline-end: calc\([^)]*--_chat-entry-frame-status-length/s,
    );
  });
});
