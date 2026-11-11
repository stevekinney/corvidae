/**
 * C#7 of the chat-stress sweep: at phone width Jump to latest covered the end of a waiting
 * approval's buttons, and it showed while the transcript sat where a waiting item's lift put it,
 * with nothing below to jump to. The page geometry is the browser's, so these read the rules.
 */
import { describe, expect, test } from 'bun:test';

const controls = await Bun.file(new URL('./chat-jump-controls.svelte', import.meta.url)).text();
const chat = await Bun.file(new URL('./chat.svelte', import.meta.url)).text();

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
  test('takes its own line at the composer edge instead of floating over the transcript', () => {
    const narrow = containerBlock(controls, '@container (max-width: 30rem) {');
    expect(narrow).toMatch(/\.chat-jump-button\s*\{[^}]*position: relative;[^}]*bottom: auto;/);
    expect(narrow).toMatch(
      /\.chat-new-indicator\s*\{[^}]*position: relative;[^}]*transform: none;/,
    );
  });

  test('stays hidden while the transcript sits where a waiting item lifted it', () => {
    expect(chat).toContain('showJumpButton={scrollState.showJumpButton && !attentionLifted}');
    // The lift sets it, and the person's own scroll, touch, click or key clears it.
    expect(chat).toMatch(/scroller\.scrollTop \+= shift;\s*attentionLifted = true;/);
    expect(chat).toMatch(/released = target !== null;\s*attentionLifted = false;/);
  });
});
