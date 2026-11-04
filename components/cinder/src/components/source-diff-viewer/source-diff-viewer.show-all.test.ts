/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: SourceDiffViewer, countPatchChanges } = await import('./index.ts');

afterEach(() => cleanup());

/** A prompt edited in a few places, as the audit log shows a long change. */
const longPatch = [
  '--- a/instructions.md',
  '+++ b/instructions.md',
  '@@ -1,6 +1,7 @@',
  ' You handle refund requests and order questions.',
  '-Always answer within two sentences.',
  '+Answer in as many sentences as the question needs, and',
  '+link the order page whenever an order number appears.',
  ' Escalate refunds over $100 to a person.',
  ' Never promise a refund date.',
  ' Sign off with your name.',
  '',
].join('\n');

/** The patch the payload renderer's board shows: +3 −1, nine lines long. */
const releaseNotesPatch = [
  '--- a/release-notes.md',
  '+++ b/release-notes.md',
  '@@ -12,3 +12,5 @@',
  ' # Release notes',
  '-Refunds are sent at once.',
  '+Refunds now ask for approval before money moves.',
  '+Large refunds go to a person.',
  '+Nothing is sent without a note.',
  ' Thanks for reading.',
  '',
].join('\n');

function lineTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.cinder-source-diff-viewer__line-code')).map(
    (code) => code.textContent?.trim() ?? '',
  );
}

describe('SourceDiffViewer: Show all', () => {
  test('a truncated patch ends in a footer with the count and a Show all action', () => {
    const { container, getByRole } = render(SourceDiffViewer, {
      patch: longPatch,
      maxLines: 3,
      lineNumbers: false,
    });
    const footer = requiredInstance(
      container.querySelector('.cinder-source-diff-viewer__footer'),
      HTMLElement,
    );
    expect(footer.querySelector('[role="status"]')?.textContent?.trim()).toBe(
      'Showing 3 of 7 changed lines',
    );
    expect(getByRole('button', { name: 'Show all' }).textContent?.trim()).toBe('Show all');
    // The old banner above the rows is gone.
    expect(container.querySelector('.cinder-source-diff-viewer__notice')).toBeNull();
  });

  test('Show all renders every row in place and moves focus to the live status', async () => {
    const { container, getByRole, queryByRole } = render(SourceDiffViewer, {
      patch: longPatch,
      maxLines: 3,
    });
    expect(container.querySelectorAll('.cinder-source-diff-viewer__line')).toHaveLength(3);
    await fireEvent.click(getByRole('button', { name: 'Show all' }));
    await Promise.resolve();
    expect(container.querySelectorAll('.cinder-source-diff-viewer__line')).toHaveLength(7);
    expect(queryByRole('button', { name: 'Show all' })).toBeNull();
    const status = requiredInstance(
      container.querySelector('.cinder-source-diff-viewer__footer [role="status"]'),
      HTMLElement,
    );
    expect(status.textContent?.trim()).toBe('Showing all 7 lines');
    expect(document.activeElement).toBe(status);
  });

  test('a patch that fits has no footer', () => {
    const { container } = render(SourceDiffViewer, { patch: longPatch, maxLines: 50 });
    expect(container.querySelector('.cinder-source-diff-viewer__footer')).toBeNull();
  });

  test('expanded is bindable from outside: set, it shows every row with no action', () => {
    const { container } = render(SourceDiffViewer, {
      patch: longPatch,
      maxLines: 2,
      expanded: true,
    });
    expect(container.querySelectorAll('.cinder-source-diff-viewer__line')).toHaveLength(7);
    expect(container.querySelector('.cinder-source-diff-viewer__show-all')).toBeNull();
  });

  test('showAllLabel names the action', () => {
    const { getByRole } = render(SourceDiffViewer, {
      patch: longPatch,
      maxLines: 2,
      showAllLabel: 'Show the whole change',
    });
    expect(getByRole('button', { name: 'Show the whole change' })).not.toBeNull();
  });
});

describe('SourceDiffViewer: inline variant', () => {
  test('previews the first two changed lines as bare rows, with no headers, gutter or frame', () => {
    const { container } = render(SourceDiffViewer, {
      patch: releaseNotesPatch,
      variant: 'inline',
      maxLines: 2,
    });
    expect(lineTexts(container)).toEqual([
      '- Refunds are sent at once.',
      '+ Refunds now ask for approval before money moves.',
    ]);
    expect(
      Array.from(container.querySelectorAll('[data-cinder-line-kind]')).map((line) =>
        line.getAttribute('data-cinder-line-kind'),
      ),
    ).toEqual(['removal', 'addition']);
    expect(container.querySelector('.cinder-source-diff-viewer__file-header')).toBeNull();
    expect(container.querySelector('.cinder-source-diff-viewer__hunk-header')).toBeNull();
    expect(container.querySelector('.cinder-source-diff-viewer__line-number')).toBeNull();
    expect(
      container.querySelector('.cinder-source-diff-viewer')?.getAttribute('data-cinder-variant'),
    ).toBe('inline');
  });

  test('offers "Show all 9 lines", the number of lines in the patch, under the rows', () => {
    const { container, getByRole } = render(SourceDiffViewer, {
      patch: releaseNotesPatch,
      variant: 'inline',
      maxLines: 2,
    });
    const link = getByRole('button', { name: 'Show all 9 lines' });
    expect(link.querySelector('svg')).not.toBeNull();
    // No "Showing x of y" status beside it: the link says it all.
    expect(container.querySelector('.cinder-source-diff-viewer__footer-status')).toBeNull();
  });

  test('Show all renders the whole patch, headers and context included', async () => {
    const { container, getByRole } = render(SourceDiffViewer, {
      patch: releaseNotesPatch,
      variant: 'inline',
      maxLines: 2,
    });
    await fireEvent.click(getByRole('button', { name: 'Show all 9 lines' }));
    expect(lineTexts(container)).toContain('# Release notes');
    expect(lineTexts(container)).toContain('Thanks for reading.');
    expect(container.querySelector('.cinder-source-diff-viewer__hunk-header')?.textContent).toBe(
      '@@ -12,3 +12,5 @@',
    );
  });

  test('names every row for a screen reader, as the full viewer does', () => {
    const { container } = render(SourceDiffViewer, {
      patch: releaseNotesPatch,
      variant: 'inline',
      maxLines: 2,
    });
    expect(container.textContent).toContain('Removed line 13: Refunds are sent at once.');
  });

  test('a patch with no more than the preview shows has no link', () => {
    const { container } = render(SourceDiffViewer, {
      patch: '@@ -1 +1 @@\n-a\n+b\n',
      variant: 'inline',
      maxLines: 2,
    });
    expect(container.querySelector('.cinder-source-diff-viewer__show-all')).toBeNull();
    expect(lineTexts(container)).toEqual(['- a', '+ b']);
  });
});

describe('countPatchChanges', () => {
  test('counts added and removed lines for a "+3 −1" summary', () => {
    expect(countPatchChanges(releaseNotesPatch)).toEqual({ added: 3, removed: 1 });
  });

  test('counts across files and hunks, and counts none for text that is not a patch', () => {
    expect(
      countPatchChanges(
        '--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n--- a/b\n+++ b/b\n@@ -1 +1,2 @@\n z\n+w\n',
      ),
    ).toEqual({ added: 2, removed: 1 });
    expect(countPatchChanges('just some words\n')).toEqual({ added: 0, removed: 0 });
    expect(countPatchChanges('')).toEqual({ added: 0, removed: 0 });
  });
});
