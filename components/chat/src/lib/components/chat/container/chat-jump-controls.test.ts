/**
 * C#7 of the chat-stress sweep: at phone width Jump to latest covered the end of a waiting
 * approval's buttons, and it showed while the transcript sat where a waiting item's lift put it,
 * with nothing below to jump to. The page geometry is the browser's, so these read the rules.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { flushSync, mount, unmount } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const controls = await Bun.file(new URL('./chat-jump-controls.svelte', import.meta.url)).text();
const chat = await Bun.file(new URL('./chat.svelte', import.meta.url)).text();
const { default: ChatJumpControls } = await import('./chat-jump-controls.svelte');

afterEach(() => document.body.replaceChildren());

describe('Jump to latest on a phone', () => {
  test('forwards host labels to the mounted unread-message control', () => {
    const target = document.createElement('div');
    document.body.append(target);
    const instance = mount(ChatJumpControls, {
      target,
      props: {
        showJumpButton: false,
        hasNewMessageIndicator: true,
        unreadCount: 2,
        displayUnreadCount: '2',
        hasLargeCount: false,
        labels: {
          jumpToLatest: 'Go to newest',
          jumpToNewMessages: (count: number) => `Open ${count} pending replies`,
          newMessages: (count: number) => `${count} pending replies`,
        },
      },
    });
    flushSync();

    const indicator = target.querySelector<HTMLButtonElement>('.chat-new-indicator');
    expect(indicator?.getAttribute('aria-label')).toBe('2 pending replies');
    expect(indicator?.textContent?.trim()).toBe('2 pending replies');
    unmount(instance);
  });

  test('floats over the transcript without a band, painted 32 px with a 44 px hit area', () => {
    expect(controls).toMatch(
      /\.chat-jump-dock\s*\{[^}]*position: absolute;[^}]*inset-block-end: calc\(100%/,
    );
    expect(controls).toMatch(/\.chat-jump-button\s*\{[^}]*width: 2rem;[^}]*height: 2rem;/);
    expect(controls).toMatch(
      /\.chat-jump-button::before\s*\{[^}]*position: absolute;[^}]*inset: calc\([^;]*- 1px\);/,
    );
    // Nothing moves it back into the flow on a phone, where it would reserve a strip.
    expect(controls).not.toContain('@container (max-width: 30rem)');
  });

  test('stays hidden while the transcript sits where a waiting item lifted it', () => {
    expect(chat).toContain('showJumpButton={scrollState.showJumpButton && !attentionLifted}');
    // The lift sets it; only the transcript moving from where the lift left it, or nothing
    // waiting any more, clears it. A press inside the card does not, so the control never comes in
    // under the finger mid-press.
    expect(chat).toMatch(
      /scroller\.scrollTop \+= shift;\s*liftedTop = scroller\.scrollTop;\s*attentionLifted = true;/,
    );
    expect(chat).toMatch(
      /Math\.abs\(scroller\.scrollTop - liftedTop\) > 2\) \{\s*attentionLifted = false;/,
    );
    expect(chat).toMatch(/if \(next === null\) attentionLifted = false;/);
    expect(chat).not.toMatch(/released = target !== null;\s*attentionLifted = false;/);
  });
});
