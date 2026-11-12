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

function containerBlock(source: string, query: string): string {
  const start = source.indexOf(query);
  if (start === -1) throw new Error(`container query not found: ${query}`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`container query not closed: ${query}`);
}

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

  test('takes its own line at the composer edge instead of floating over the transcript', () => {
    const narrow = containerBlock(controls, '@container (max-width: 30rem) {');
    expect(narrow).toMatch(/\.chat-jump-button\s*\{[^}]*position: relative;[^}]*bottom: auto;/);
    expect(narrow).toMatch(
      /\.chat-new-indicator\s*\{[^}]*position: relative;[^}]*transform: none;/,
    );
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
