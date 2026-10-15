import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Chat's own tokens are documented in Cinder's token reference, and this pins the two together.
 * It lived in Cinder's `src/styles` until @lostgradient/chat stopped publishing (2026-10-14): the
 * Cinder mirror no longer carries Chat's source, so a Cinder test that read it would throw there.
 * It belongs to Chat, which now runs only in corvidae.
 */
const repositoryRoot = join(import.meta.dirname, '..', '..', '..', '..', '..', '..');
const chatComponentDirectory = import.meta.dirname;
const tokenDocumentationPath = join(repositoryRoot, 'components/cinder/documentation/tokens.md');
const tokenBaseCssPath = join(repositoryRoot, 'components/cinder/src/styles/tokens-base.css');

describe('Chat tokens in the Cinder token reference', () => {
  it('documents the Chat typography control and keeps it out of the color contract', () => {
    const chatCss = readFileSync(join(chatComponentDirectory, 'chat.css'), 'utf8');
    const tokenDocumentation = readFileSync(tokenDocumentationPath, 'utf8');

    expect(chatCss).toContain('--cinder-chat-font-size: 1rem');
    expect(chatCss).toContain('--_cinder-chat-text-base: clamp(');
    expect(tokenDocumentation).toContain('`--cinder-chat-font-size`');
  });

  // Publishing a token through `chat.variables.*` and the generated README
  // makes it supported customization API, which carries a documentation
  // obligation. This pins that obligation so the two cannot drift: a default
  // changed in CSS without the docs following, or the token removed from one
  // side only, fails here.
  it('documents the Chat transcript measure and keeps it out of the color contract', () => {
    const chatCss = readFileSync(join(chatComponentDirectory, 'chat.css'), 'utf8');
    const chatVariables = readFileSync(join(chatComponentDirectory, 'chat.variables.json'), 'utf8');
    const tokenDocumentation = readFileSync(tokenDocumentationPath, 'utf8');
    const tokenBaseCss = readFileSync(tokenBaseCssPath, 'utf8');

    // Registered with `@property` (so ancestor overrides inherit) rather than
    // declared on the component root, where a value would beat inheritance.
    expect(chatCss).toMatch(
      /@property --cinder-chat-message-max-width \{\s*syntax: '\*';\s*inherits: true;\s*initial-value: 48rem;\s*\}/,
    );
    expect(chatCss).not.toMatch(/--cinder-chat-message-max-width:\s*[^;]+;/);
    // Registered in the CSS sidecar rather than a scoped <style>, which is what
    // makes it reachable by the artifact generator at all.
    expect(chatVariables).toContain('--cinder-chat-message-max-width');
    expect(tokenDocumentation).toContain('`--cinder-chat-message-max-width`');
    expect(tokenDocumentation).toContain('48rem');
    // A layout measure has no contrast to gate. It belongs to Chat's sidecar,
    // not to the color contract this file audits, so its absence from
    // `tokens-base.css` is part of what is being pinned.
    expect(tokenBaseCss).not.toContain('--cinder-chat-message-max-width');
  });
});
