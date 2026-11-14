/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import type { Highlighter } from '../../utilities/highlighter.ts';
import type { CodeBlockProps } from './code-block.types.ts';

setupHappyDom();

const { cleanup, render, waitFor } = await import('@testing-library/svelte');
const { default: CodeBlock } = await import('./code-block.svelte');
const { default: CodeHighlighterContextFixture } =
  await import('../../test/fixtures/code-highlighter-context-fixture.svelte');

// CodeBlock emits a dev warning when a highlighter throws / fails to load (it
// then falls back to escaped plain code). Several tests exercise that path on
// purpose, so we spy (rather than blanket-silence) and assert in afterEach that
// every warning is that known fallback message — any UNEXPECTED warning fails.
const KNOWN_CODE_BLOCK_WARNING = '[cinder/CodeBlock] highlight failed';
let warnSpy: ReturnType<typeof spyOn<typeof console, 'warn'>>;

beforeEach(() => {
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  // Unmount rendered components BEFORE the warning assertion: component teardown
  // may emit console.warn, so cleanup must run while warnSpy is still installed.
  // @testing-library/svelte v5's auto-cleanup does not register under bun:test, so
  // without this the mounted code blocks leak into the shared happy-dom
  // document.body and later sibling files (e.g. copy-button) see duplicate elements.
  cleanup();
  const unexpected = warnSpy.mock.calls
    .map((args) => args.map(String).join(' '))
    .filter((message) => !message.includes(KNOWN_CODE_BLOCK_WARNING));
  // Restore in `finally` so an unexpected-warning failure can't leave
  // `console.warn` patched for every subsequent test in the suite.
  try {
    expect(unexpected).toEqual([]);
  } finally {
    warnSpy.mockRestore();
  }
});

/** A custom highlighter that tags its output so we can assert it ran. */
function customHighlighter(code: string, _lang: string): string {
  return `<pre class="shiki"><code><span class="custom-token">${code}</span></code></pre>`;
}

/** A context highlighter that tags its output differently from the prop one. */
function contextHighlighter(code: string, _lang: string): string {
  return `<pre class="shiki shiki-context"><code>${code}</code></pre>`;
}

/** Render `CodeBlock` with `props` beneath a published context highlighter. */
function renderWithContext(highlighter: Highlighter, props: CodeBlockProps) {
  return render(CodeHighlighterContextFixture, {
    highlighter,
    component: CodeBlock,
    childProps: props,
  });
}

describe('CodeBlock — static structure', () => {
  test('keeps copy chrome unselectable while code detail remains selectable', async () => {
    const css = await Bun.file(new URL('./code-block.css', import.meta.url)).text();

    expect(css).toMatch(/\.cinder-code-block\s*\{[^}]*user-select:\s*none/s);
    expect(css).toMatch(/\.cinder-code-block__viewport\s*\{[^}]*user-select:\s*text/s);
  });
  test('renders code in a <pre><code> pair (no language → no highlight)', async () => {
    const highlighter = mock(contextHighlighter);
    const { container } = renderWithContext(highlighter, { code: 'const x = 1;' });
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.querySelector('code')?.textContent).toBe('const x = 1;');
    // With no language, even a published highlighter must never run.
    await Promise.resolve();
    expect(highlighter).not.toHaveBeenCalled();
    expect(
      container.querySelector('.cinder-code-block')?.getAttribute('data-cinder-highlight-state'),
    ).toBe('plain');
  });

  test('stable viewport has tabindex="0" for keyboard scroll access', () => {
    const { container } = render(CodeBlock, { code: 'const x = 1;' });
    const viewport = container.querySelector('.cinder-code-block__viewport');
    const pre = container.querySelector('pre.cinder-code-block__pre');
    expect(viewport).not.toBeNull();
    expect(viewport?.getAttribute('tabindex')).toBe('0');
    expect(pre).not.toBeNull();
    expect(pre?.hasAttribute('tabindex')).toBe(false);
  });

  test('scrollFadeVisible is off by default — no inline scroll-fade classes', () => {
    const { container } = render(CodeBlock, { code: 'const x = 1;' });
    const viewport = container.querySelector('.cinder-code-block__viewport');
    expect(viewport?.classList.contains('cinder-_scroll-fade-inline-start')).toBe(false);
    expect(viewport?.classList.contains('cinder-_scroll-fade-inline-end')).toBe(false);
  });

  test('scrollFadeVisible adds BOTH inline-edge fade classes to the viewport', () => {
    const { container } = render(CodeBlock, { code: 'const x = 1;', scrollFadeVisible: true });
    const viewport = container.querySelector('.cinder-code-block__viewport');
    expect(viewport?.classList.contains('cinder-_scroll-fade-inline-start')).toBe(true);
    expect(viewport?.classList.contains('cinder-_scroll-fade-inline-end')).toBe(true);
  });

  test('code-block.css ends the scroll fade in the viewport surface', async () => {
    const cssPath = new URL('./code-block.css', import.meta.url);
    const source = await Bun.file(cssPath).text();
    expect(source).toContain('--_cinder-scroll-fade-color: var(--cinder-code-block-background);');
  });

  test('preserves two-space tab sizing on plain and highlighted code via the shared token', async () => {
    const css = await Bun.file(new URL('./code-block.css', import.meta.url)).text();
    expect(css).toContain('tab-size: var(--cinder-type-tab-size);');
  });

  test('public source-excerpt variables control the shared viewport and both render paths', async () => {
    const css = await Bun.file(new URL('./code-block.css', import.meta.url)).text();
    expect(css).not.toContain('--cinder-code-block-height:');
    expect(css).toContain('block-size: var(--cinder-code-block-height)');
    expect(css).toContain('font-size: var(--cinder-code-block-font-size)');
    expect(css).toContain('line-height: var(--cinder-code-block-line-height)');
    expect(css).not.toContain('--cinder-code-block-padding:');
    expect(css).toContain('.cinder-code-block :where(pre.shiki)');
  });

  test('renders no header bar and no border frame, even with a language label and copy button', async () => {
    const { container } = render(CodeBlock, {
      code: 'const x',
      language: 'ts',
      highlight: false,
      copyable: true,
    });
    expect(container.querySelector('header')).toBeNull();
    expect(container.querySelector('.cinder-code-block__header')).toBeNull();

    const css = await Bun.file(new URL('./code-block.css', import.meta.url)).text();
    expect(css).not.toContain('.cinder-code-block__header');
    expect(css).toMatch(/\.cinder-code-block\s*\{(?:(?!\}).)*\}/s);
    const rootRule = /\.cinder-code-block\s*\{([^}]*)\}/s.exec(css)?.[1] ?? '';
    expect(rootRule).not.toMatch(/\bborder\s*:/);
    const metaRule = /\.cinder-code-block__meta\s*\{([^}]*)\}/s.exec(css)?.[1] ?? '';
    expect(metaRule).not.toMatch(/\bborder(?:-[a-z]+)?\s*:/);
  });

  test('language prop renders a language label above the code', () => {
    const { container } = render(CodeBlock, { code: 'const x', language: 'ts', highlight: false });
    const label = container.querySelector('.cinder-code-block__language');
    expect(label?.textContent?.trim()).toBe('ts');
  });

  test('meta row is omitted when neither language nor copyable is set', () => {
    const { container } = render(CodeBlock, { code: 'plain' });
    expect(container.querySelector('.cinder-code-block__meta')).toBeNull();
  });

  test('languageLabelVisible=false suppresses the meta row while keeping language semantics', () => {
    const { container } = render(CodeBlock, {
      code: 'const x',
      language: 'ts',
      highlight: false,
      languageLabelVisible: false,
    });
    expect(container.querySelector('.cinder-code-block__meta')).toBeNull();
    expect(container.querySelector('.cinder-code-block__language')).toBeNull();
  });

  test('languageLabelVisible=false keeps the meta row when copyable is set', () => {
    const { container } = render(CodeBlock, {
      code: 'const x',
      language: 'ts',
      highlight: false,
      copyable: true,
      languageLabelVisible: false,
    });
    expect(container.querySelector('.cinder-code-block__meta')).not.toBeNull();
    expect(container.querySelector('.cinder-code-block__language')).toBeNull();
    expect(container.querySelector('.cinder-copy-button')).not.toBeNull();
  });

  test('copyable=true renders a copy button in the meta row', () => {
    const { container } = render(CodeBlock, { code: 'x', copyable: true });
    expect(container.querySelector('.cinder-code-block__meta')).not.toBeNull();
    expect(container.querySelector('.cinder-copy-button')).not.toBeNull();
  });

  test('the copy button is named for the language it copies', () => {
    const { container } = render(CodeBlock, {
      code: 'SELECT 1;',
      language: 'sql',
      highlight: false,
      copyable: true,
    });
    expect(container.querySelector('.cinder-copy-button')?.getAttribute('aria-label')).toBe(
      'Copy sql code',
    );
  });

  test('copyFloating floats the copy button with no header row of its own', async () => {
    const { container } = render(CodeBlock, {
      code: 'SELECT 1;',
      language: 'sql',
      highlight: false,
      copyable: true,
      copyFloating: true,
      languageLabelVisible: false,
    });
    const block = container.querySelector('.cinder-code-block');
    expect(block?.classList.contains('cinder-code-block--floating-meta')).toBe(true);
    expect(container.querySelector('.cinder-code-block__language')).toBeNull();
    expect(container.querySelector('.cinder-copy-button')).not.toBeNull();

    const css = await Bun.file(new URL('./code-block.css', import.meta.url)).text();
    expect(css).toMatch(/\.cinder-code-block--floating-meta\s*\{[^}]*position:\s*relative/s);
    expect(css).toMatch(
      /\.cinder-code-block--floating-meta \.cinder-code-block__meta\s*\{[^}]*position:\s*absolute/s,
    );
  });

  // C#5 (chat stress sweep): the floating button sat on the characters and the overflow fade of a
  // one-line block, because nothing reserved its space.
  test('copyFloating reserves the button width at the inline end, so code and fade stop before it', async () => {
    const source = await Bun.file(new URL('./code-block.css', import.meta.url)).text();
    const css = source.replace(/\s+/g, ' ');
    const reserve =
      /\.cinder-code-block--floating-meta:has\(> \.cinder-code-block__meta\) \{([^}]*)\}/.exec(
        css,
      )?.[1];
    expect(reserve).toContain('min-block-size: var(--_cinder-code-block-float-reserve);');
    expect(css).toContain(
      '--_cinder-code-block-float-reserve: calc( var(--_cinder-code-block-float-size) + 2 * var(--cinder-space-2) );',
    );
    const button =
      /\.cinder-code-block--floating-meta \.cinder-code-block__meta \.cinder-copy-button \{([^}]*)\}/.exec(
        css,
      )?.[1];
    expect(button).toContain('inline-size: var(--_cinder-code-block-float-size);');
  });

  test('copyFloating gives the viewport its own rail reservation and end cue', async () => {
    const source = await Bun.file(new URL('./code-block.css', import.meta.url)).text();
    const css = source.replace(/\s+/g, ' ');
    expect(css).toMatch(
      /\.cinder-code-block--floating-meta:has\(> \.cinder-code-block__meta\) \.cinder-code-block__viewport\s*\{[^}]*scroll-padding-inline-end:\s*var\(--_cinder-code-block-float-reserve\);[^}]*margin-inline-end:\s*var\(--_cinder-code-block-float-reserve\);/,
    );
    expect(css).toMatch(
      /\.cinder-code-block--floating-meta \.cinder-code-block__viewport\.cinder-_scroll-fade-inline-end\[data-cinder-overflows-inline-end\]::after\s*\{[^}]*inset-inline-end:\s*var\(--_cinder-code-block-float-reserve\);/,
    );
  });

  // The copy button keeps its 28px painted box on touch: CopyButton draws the 44px hit area with a
  // pseudo-element, so the code block never grows or reserves more for a finger.
  test('the copy button is not resized on a coarse pointer, so its hit area adds no layout', async () => {
    const source = await Bun.file(new URL('./code-block.css', import.meta.url)).text();
    const css = source.replace(/\s+/g, ' ');
    expect(css).not.toMatch(/@media \((?:any-)?pointer: coarse\)/);
    expect(css).not.toContain('--_cinder-code-block-float-size: var(--cinder-touch-target-min)');
  });

  test('copyFloating draws Copy without a background at rest, centred on the first code line', async () => {
    const source = await Bun.file(new URL('./code-block.css', import.meta.url)).text();
    const css = source.replace(/\s+/g, ' ');
    const button =
      /\.cinder-code-block--floating-meta \.cinder-code-block__meta \.cinder-copy-button \{([^}]*)\}/.exec(
        css,
      )?.[1];
    expect(button).toContain('background: transparent;');
    const meta = /\.cinder-code-block--floating-meta \.cinder-code-block__meta \{([^}]*)\}/.exec(
      css,
    )?.[1];
    expect(meta).toMatch(
      /inset-block-start: calc\( var\(--cinder-code-block-padding\) \+ var\(--cinder-code-block-font-size\) \* var\(--cinder-code-block-line-height\) \/ 2 \);/,
    );
    expect(meta).toContain('transform: translateY(-50%);');
    // The strip behind Copy is the code's own surface, not the tinted block.
    expect(css).toMatch(
      /\.cinder-code-block--floating-meta \{[^}]*background: var\(--cinder-code-block-background\);/,
    );
  });

  test('a wrapping block breaks at whitespace and splits a token only when it is longer than the line', async () => {
    const source = await Bun.file(new URL('./code-block.css', import.meta.url)).text();
    const css = source.replace(/\s+/g, ' ');
    expect(css).toMatch(
      /\.cinder-code-block--wrap \.cinder-code-block__pre, \.cinder-code-block--wrap :where\(pre\.shiki\) \{[^}]*overflow-wrap: break-word;/,
    );
    // Only a flag's own box may break anywhere (a flag longer than the line); lines never do.
    expect(css).not.toMatch(/--wrap \.cinder-code-block__line \{[^}]*overflow-wrap: anywhere/);
  });

  test('the streaming label sits inside the block padding, not on its edge', async () => {
    const source = await Bun.file(new URL('./code-block.css', import.meta.url)).text();
    const css = source.replace(/\s+/g, ' ');
    expect(css).toMatch(
      /\.cinder-code-block--streaming:not\(\.cinder-code-block--floating-meta\) \.cinder-code-block__meta \{[^}]*padding-block-start: var\(--cinder-code-block-padding\);/,
    );
    expect(css).toMatch(
      /\.cinder-code-block--floating-meta \.cinder-code-block__status \{[^}]*margin-inline-end: max\(0px, calc\(var\(--cinder-code-block-padding\) - var\(--cinder-space-1\)\)\);/,
    );
  });

  test('a wrapping block keeps each flag whole and copies the same text', () => {
    const code = 'refund --order 4471 --notify customer';
    const { container } = render(CodeBlock, { code, wrap: true });
    const flags = Array.from(
      container.querySelectorAll('.cinder-code-block__flag'),
      (flag) => flag.textContent,
    );
    expect(flags).toEqual(['--order', '--notify']);
    expect(container.querySelector('pre code')?.textContent).toBe(code);
    const plain = render(CodeBlock, { code });
    expect(plain.container.querySelector('.cinder-code-block__flag')).toBeNull();
  });

  test('streaming withholds copy, shows its status, and puts the caret after the last character', () => {
    const { container } = render(CodeBlock, {
      code: 'SELECT id',
      language: 'sql',
      copyable: true,
      streaming: true,
      languageLabelVisible: false,
    });
    const block = container.querySelector('.cinder-code-block');
    expect(block?.classList.contains('cinder-code-block--streaming')).toBe(true);
    expect(block?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('.cinder-copy-button')).toBeNull();
    expect(container.querySelector('.cinder-code-block__status')?.textContent).toBe('Writing…');

    const code = container.querySelector('pre code');
    const caret = code?.lastElementChild;
    expect(caret?.classList.contains('cinder-code-block__caret')).toBe(true);
    expect(caret?.getAttribute('aria-hidden')).toBe('true');
    // The caret is drawn, not text: the code reads and copies exactly as written.
    expect(code?.textContent).toBe('SELECT id');
  });

  test('streaming caret is a two-pixel accent bar', async () => {
    const css = await Bun.file(new URL('./code-block.css', import.meta.url)).text();
    expect(css).toMatch(
      /\.cinder-code-block__caret\s*\{[^}]*inline-size:\s*2px;[^}]*background:\s*var\(--cinder-accent-solid\);/s,
    );
  });

  test('streaming does not highlight until the last token, then copy returns', async () => {
    const highlighter = mock(contextHighlighter);
    const view = renderWithContext(highlighter, {
      code: 'SELECT id',
      language: 'sql',
      copyable: true,
      streaming: true,
    });
    await Promise.resolve();
    expect(highlighter).not.toHaveBeenCalled();

    await view.rerender({
      highlighter,
      component: CodeBlock,
      childProps: { code: 'SELECT id FROM users;', language: 'sql', copyable: true },
    });
    await waitFor(() => expect(highlighter).toHaveBeenCalled());
    expect(view.container.querySelector('.cinder-copy-button')).not.toBeNull();
    expect(view.container.querySelector('.cinder-code-block__caret')).toBeNull();
    expect(view.container.querySelector('.cinder-code-block__status')).toBeNull();
  });

  test('streamingLabel replaces the default status', () => {
    const { container } = render(CodeBlock, {
      code: 'x',
      streaming: true,
      streamingLabel: 'Receiving',
    });
    expect(container.querySelector('.cinder-code-block__status')?.textContent).toBe('Receiving');
  });

  test('copyable=true renders the copy button in iconOnly mode (no text label)', () => {
    const { container } = render(CodeBlock, { code: 'x', copyable: true });
    const button = container.querySelector('.cinder-copy-button');
    expect(button).not.toBeNull();
    expect(button?.querySelector('svg')).not.toBeNull();
    expect(button?.textContent?.trim()).toBe('');
  });

  test('copy button focus ring is inset inside the overflow-hidden shell', async () => {
    const css = await Bun.file(new URL('./code-block.css', import.meta.url)).text();
    expect(css).toContain(
      '.cinder-code-block .cinder-code-block__meta .cinder-copy-button:focus-visible',
    );
    expect(css).toContain(
      'box-shadow: inset 0 0 0 var(--cinder-ring-width) var(--cinder-ring-color);',
    );
  });

  test('copy button focus ring remains visible in forced-colors mode', async () => {
    const css = await Bun.file(new URL('./code-block.css', import.meta.url)).text();
    expect(css).toContain('@media (forced-colors: active)');
    // The copy-button forced-colors fallback uses the full outline shorthand (not outline-color)
    // so it overpaints the transparent placeholder outline.
    expect(css).toContain('outline: var(--cinder-ring-width) solid ButtonText;');
    expect(css).toContain('box-shadow: none;');
  });

  test('CSS contains dark-theme rule that overrides shiki span color with --shiki-dark', async () => {
    const css = await Bun.file(new URL('./code-block.css', import.meta.url)).text();
    // The rule must cover the [data-cinder-theme='dark'] selector (playground uses this).
    expect(css).toContain("data-cinder-theme='dark'");
    // The rule must switch the inline `color:` to the --shiki-dark custom property.
    expect(css).toContain('color: var(--shiki-dark, inherit)');
  });

  test('CSS contains prefers-color-scheme: dark fallback for system dark mode', async () => {
    const css = await Bun.file(new URL('./code-block.css', import.meta.url)).text();
    expect(css).toContain('@media (prefers-color-scheme: dark)');
  });

  test("github-light's orange takes Cinder's warning text, which meets AA on the white field", async () => {
    const css = await Bun.file(new URL('./code-block.css', import.meta.url)).text();
    expect(css).toContain(
      ".cinder-code-block :where(pre.shiki) span[style*='E36209;' i] {\n    color: var(--cinder-status-warning-text) !important;",
    );
  });

  test('code surface background is one component-owned declaration', async () => {
    const css = await Bun.file(new URL('./code-block.css', import.meta.url)).text();
    // One surface: the root (and so the bar) takes the code's own fill, and its one edge is a
    // hairline in the light theme only.
    expect(css).not.toContain('background: var(--cinder-surface-inset);');
    expect(css).toContain('box-shadow: inset 0 0 0 1px var(--cinder-code-block-edge);');
    expect(css).toContain('background: var(--cinder-code-block-background);');
    expect(css).toContain('background: var(--cinder-code-block-background) !important;');
  });

  test('stable viewport carries inset focus ring (regression #398)', async () => {
    // .cinder-code-block has overflow:hidden, so the standard outset focus ring is
    // clipped. The fix adds an INSET box-shadow ring to the stable focusable
    // viewport. This test locks that pattern so it cannot silently regress.
    const css = await Bun.file(new URL('./code-block.css', import.meta.url)).text();
    expect(css).toContain('.cinder-code-block__viewport:focus-visible');
    // The rule must use an inset box-shadow (not an outset ring that would be clipped).
    expect(css).toMatch(
      /\.cinder-code-block__viewport:focus-visible[\s\S]*?box-shadow:\s*inset\s+0\s+0\s+0\s+var\(--cinder-ring-width\)\s+var\(--cinder-ring-color\)/,
    );
    // The outline must be set to transparent so the inset shadow is the visible ring.
    expect(css).toMatch(
      /\.cinder-code-block__viewport:focus-visible[\s\S]*?outline:\s*var\(--cinder-ring-width\)\s+solid\s+transparent/,
    );
  });
});

describe('CodeBlock — highlighter resolution (prop, then context, then none)', () => {
  test('a context-provided highlighter highlights a block with no highlighter prop', async () => {
    const highlighter = mock(contextHighlighter);
    const { container } = renderWithContext(highlighter, { code: 'const x = 1;', language: 'js' });
    await waitFor(() => {
      const block = container.querySelector('.cinder-code-block__highlighted .shiki-context');
      expect(block).not.toBeNull();
      expect(block?.textContent).toBe('const x = 1;');
    });
    expect(highlighter).toHaveBeenCalledTimes(1);
    expect(highlighter).toHaveBeenCalledWith('const x = 1;', 'js');
    // The context highlighter output replaces the plain fallback.
    expect(container.querySelector('.cinder-code-block__pre')).toBeNull();
    expect(
      container.querySelector('.cinder-code-block')?.getAttribute('data-cinder-highlight-state'),
    ).toBe('ready');
  });

  test('an explicit highlighter prop wins over the context highlighter', async () => {
    const fromContext = mock(contextHighlighter);
    const { container } = renderWithContext(fromContext, {
      code: 'const x = 1;',
      language: 'js',
      highlighter: customHighlighter,
    });
    await waitFor(() => {
      expect(container.querySelector('.custom-token')?.textContent).toBe('const x = 1;');
    });
    expect(container.querySelector('.shiki-context')).toBeNull();
    // Prove the context highlighter never ran — not just that its output is absent.
    expect(fromContext).not.toHaveBeenCalled();
  });

  test('with neither a prop nor a context highlighter the block renders unhighlighted', async () => {
    const { container } = render(CodeBlock, { code: 'const x = 1;', language: 'js' });
    // Let any (mistaken) async highlight path settle before asserting.
    await Promise.resolve();
    await Promise.resolve();
    expect(container.querySelector('.cinder-code-block__highlighted')).toBeNull();
    expect(container.querySelector('pre.cinder-code-block__pre')).not.toBeNull();
    expect(container.querySelector('.cinder-code-block__code')?.textContent).toBe('const x = 1;');
    // The language label still renders: only the colorization is absent.
    expect(container.querySelector('.cinder-code-block__language')?.textContent?.trim()).toBe('js');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('highlighted state keeps the stable viewport as the keyboard scroll target', async () => {
    const { container } = renderWithContext(contextHighlighter, {
      code: 'const x = 1;',
      language: 'js',
    });
    const viewportBefore = container.querySelector('.cinder-code-block__viewport');
    expect(viewportBefore).not.toBeNull();
    await waitFor(() => {
      expect(container.querySelector('.cinder-code-block__highlighted')).not.toBeNull();
    });
    const viewportAfter = container.querySelector('.cinder-code-block__viewport');
    expect(viewportAfter).toBe(viewportBefore);
    expect(viewportAfter?.getAttribute('tabindex')).toBe('0');
    expect(container.querySelector('pre.cinder-code-block__pre')).toBeNull();
  });

  test('the same viewport remains mounted when highlighting resolves', async () => {
    let resolveHighlight: ((html: string) => void) | undefined;
    const pendingHighlighter: Highlighter = () =>
      new Promise<string>((resolve) => {
        resolveHighlight = resolve;
      });

    const { container } = renderWithContext(pendingHighlighter, {
      code: 'const x = 1;',
      language: 'js',
    });

    await waitFor(() => {
      expect(resolveHighlight).toBeDefined();
      expect(container.querySelector('pre.cinder-code-block__pre')).not.toBeNull();
    });

    const viewportBefore = container.querySelector('.cinder-code-block__viewport');
    expect(viewportBefore).not.toBeNull();
    resolveHighlight?.('<pre class="shiki shiki-context"><code>const x = 1;</code></pre>');

    await waitFor(() => {
      expect(
        container.querySelector('.cinder-code-block__highlighted .shiki-context'),
      ).not.toBeNull();
    });

    expect(container.querySelector('.cinder-code-block__viewport')).toBe(viewportBefore);
  });

  test('a failing context highlighter falls back to escaped plain code (warn names language, never code)', async () => {
    const { container } = renderWithContext(
      async () => {
        throw new Error('chunk load failed');
      },
      { code: 'const secret = "p@ss";', language: 'js' },
    );
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalled();
    });
    expect(container.querySelector('.cinder-code-block__code')?.textContent).toBe(
      'const secret = "p@ss";',
    );
    // Dev warning fired, mentions the language, but NEVER the code content
    // (code blocks may contain secrets). Read from the module-level spy.
    const flattened = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(flattened).toContain('language "js"');
    expect(flattened).not.toContain('p@ss');
    expect(flattened).not.toContain('secret');
  });
});

describe('CodeBlock — explicit highlighter prop', () => {
  test('highlighter output replaces the plain pre/code and renders VERBATIM via {@html}', async () => {
    const { container } = render(CodeBlock, {
      code: 'const x = 1;',
      language: 'js',
      highlighter: customHighlighter,
    });
    await waitFor(() => {
      const token = container.querySelector('.custom-token');
      expect(token).not.toBeNull();
      // Verbatim: the highlighter's exact markup is in the DOM.
      expect(token?.textContent).toBe('const x = 1;');
      expect(container.querySelector('.cinder-code-block__pre')?.outerHTML ?? null).toBeNull();
    });
  });

  test('synchronous highlighter exception falls back to plain code', async () => {
    const { container } = render(CodeBlock, {
      code: 'const x = 1;',
      language: 'js',
      highlighter: () => {
        throw new Error('boom');
      },
    });
    await waitFor(() => {
      expect(container.querySelector('.cinder-code-block__code')?.textContent).toBe('const x = 1;');
    });
  });

  test('async highlighter rejection falls back to plain code', async () => {
    const { container } = render(CodeBlock, {
      code: 'const y = 2;',
      language: 'js',
      highlighter: async () => {
        throw new Error('async boom');
      },
    });
    await waitFor(() => {
      expect(container.querySelector('.cinder-code-block__code')?.textContent).toBe('const y = 2;');
    });
  });

  test('empty highlighter output falls back to escaped plain code', async () => {
    const { container } = render(CodeBlock, {
      code: 'const visible = true;',
      language: 'js',
      highlighter: async () => '',
    });
    await waitFor(() => {
      expect(container.querySelector('.cinder-code-block__code')?.textContent).toBe(
        'const visible = true;',
      );
    });
  });
});

describe('CodeBlock — highlight={false} absolute off switch', () => {
  test('highlight={false} keeps language label and escapes plain code with a context highlighter', async () => {
    const fromContext = mock(contextHighlighter);
    const { container } = renderWithContext(fromContext, {
      code: 'const x = 1;',
      language: 'ts',
      highlight: false,
    });
    expect(container.querySelector('.cinder-code-block__language')?.textContent?.trim()).toBe('ts');
    expect(container.querySelector('pre.cinder-code-block__pre')).not.toBeNull();
    // Give any (mistaken) async path a tick to fire, then assert it never did.
    await Promise.resolve();
    expect(fromContext).not.toHaveBeenCalled();
  });

  test('highlight={false} + explicit highlighter → highlighter is NOT called, output escaped', async () => {
    const highlighterSpy = mock(customHighlighter);
    const fromContext = mock(contextHighlighter);
    const { container } = renderWithContext(fromContext, {
      code: '<img src=x onError=alert(1)>',
      language: 'html',
      highlight: false,
      highlighter: highlighterSpy,
    });
    await Promise.resolve();
    // The off switch overrides even an explicit highlighter, and the context one.
    expect(highlighterSpy).not.toHaveBeenCalled();
    expect(fromContext).not.toHaveBeenCalled();
    // Code is escaped via Svelte text interpolation, NOT {@html}.
    const code = container.querySelector('.cinder-code-block__code');
    expect(code?.textContent).toBe('<img src=x onError=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('CodeBlock — safe-path escaping (no {@html} on the plain paths)', () => {
  // The dangerous {@html} path is ONLY a successful prop or context highlight.
  // Every plain-fallback path must escape via Svelte interpolation.
  const malicious = '<img src=x onError=alert(1)><svg onLoad=alert(2)></svg>';

  test('no language → escaped, no injected nodes', () => {
    const { container } = render(CodeBlock, { code: malicious });
    expect(container.querySelector('.cinder-code-block__code')?.textContent).toBe(malicious);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });

  test('failed context highlight → escaped, no injected nodes', async () => {
    const { container } = renderWithContext(
      async () => {
        throw new Error('load failed');
      },
      { code: malicious, language: 'html' },
    );
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalled();
    });
    expect(container.querySelector('.cinder-code-block__code')?.textContent).toBe(malicious);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });

  test('empty highlighter output → escaped, no injected nodes', async () => {
    const { container } = render(CodeBlock, {
      code: malicious,
      language: 'html',
      highlighter: async () => '',
    });
    await waitFor(() => {
      expect(container.querySelector('.cinder-code-block__code')?.textContent).toBe(malicious);
    });
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('CodeBlock — stale-async cancellation (no trusted-HTML leak)', () => {
  test('a slow stale highlight does not overwrite a newer escaped state', async () => {
    // First highlighter never resolves until we release it; by then the props
    // have changed to highlight={false}. The stale {@html} result must NOT win.
    let releaseStale: ((html: string) => void) | undefined;
    const staleHighlighter: Highlighter = () =>
      new Promise<string>((resolve) => {
        releaseStale = resolve;
      });

    const { container, rerender } = render(CodeBlock, {
      code: 'stale',
      language: 'js',
      highlighter: staleHighlighter,
    });

    await waitFor(() => {
      expect(releaseStale).toBeDefined();
    });

    // Change to the absolute off switch while the first highlight is in flight.
    await rerender({ code: 'fresh', language: 'js', highlight: false });

    // Now release the stale (trusted-HTML) result late.
    releaseStale?.('<div class="stale-token">PWNED</div>');
    await Promise.resolve();
    await Promise.resolve();

    // The latest state wins: escaped plain `fresh`, never the stale token.
    expect(container.querySelector('.stale-token')).toBeNull();
    expect(container.querySelector('.cinder-code-block__code')?.textContent).toBe('fresh');
  });

  test('changing the highlighter mid-flight renders only the latest result', async () => {
    let releaseFirst: ((html: string) => void) | undefined;
    const firstHighlighter: Highlighter = () =>
      new Promise<string>((resolve) => {
        releaseFirst = resolve;
      });

    const { container, rerender } = render(CodeBlock, {
      code: 'x',
      language: 'js',
      highlighter: firstHighlighter,
    });

    await waitFor(() => {
      expect(releaseFirst).toBeDefined();
    });

    // Swap to a synchronous highlighter that resolves immediately.
    await rerender({
      code: 'x',
      language: 'js',
      highlighter: (code: string) =>
        `<pre class="shiki"><code><span class="latest-token">${code}</span></code></pre>`,
    });

    await waitFor(() => {
      expect(container.querySelector('.latest-token')).not.toBeNull();
    });

    // Release the stale first result late — it must not overwrite the latest.
    releaseFirst?.('<div class="stale-token">stale</div>');
    await Promise.resolve();
    await Promise.resolve();

    expect(container.querySelector('.stale-token')).toBeNull();
    expect(container.querySelector('.latest-token')?.textContent).toBe('x');
  });
});
