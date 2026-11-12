import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { relative } from 'node:path';

/**
 * Painted controls are compact on touch (24 to 32px). They reach 44px through a hit area that
 * takes no layout (a pseudo-element, or the Cinder Button's own), so a Chat style that sizes
 * something with `--cinder-touch-target-min` makes the control itself a "giant button".
 *
 * Hit-area pseudo-elements set `inset`, which this guard does not match. The allowlist names the
 * sizing declarations that remain, per file, as a ceiling: it may only shrink.
 */
const sizingDeclaration =
  /^\s*(?:min-|max-)?(?:block-size|inline-size|height|width)\s*:[^;]*--cinder-touch-target-min/gm;

const allowedDeclarations: Readonly<Record<string, number>> = {
  // A full-width disclosure row, not a compact control.
  'message/entry-frame.svelte': 1,
  'message/message-sources.svelte': 1,
  'message/tool-call-timeline.svelte': 2,
  'message/parts/reasoning-part.svelte': 1,
  // Overridden to 1.5rem inside a message line; the base rule serves the standalone action.
  'message/chat-message.svelte': 2,
  'message/parts/suggestion-part.svelte': 2,
};

describe('Chat touch-target sizing', () => {
  test('no painted control is sized by the touch-target minimum beyond the allowlist', async () => {
    const root = import.meta.dir;
    const found: Record<string, number> = {};
    for await (const path of new Glob('**/*.{svelte,css}').scan({ cwd: root, absolute: true })) {
      const matches = (await Bun.file(path).text()).match(sizingDeclaration);
      if (matches !== null) found[relative(root, path)] = matches.length;
    }
    for (const [file, count] of Object.entries(found)) {
      expect(count, file).toBeLessThanOrEqual(allowedDeclarations[file] ?? 0);
    }
  });
});
