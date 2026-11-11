/**
 * The `data-state` hook on the markdown preview: `pending` while the raw-text fallback shows,
 * `rendered` once the pipeline has swapped its HTML in. The swap replaces the DOM nodes and so
 * collapses a selection made in the fallback; callers that select text wait for `rendered`.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import { quietFor } from '@lostgradient/testing/wait-until';

// setupHappyDom() MUST run before any `@testing-library/svelte` import.
setupHappyDom();
const { render, cleanup, waitFor } = await import('@testing-library/svelte');
const { default: MarkdownPreview } = await import('./markdown-preview.svelte');
const { preloadMarkdownPipeline } = await import('./markdown-pipeline.ts');

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  cleanup();
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  }
});

describe('markdown preview data-state', () => {
  test('is pending on the raw text, then rendered once the pipeline swaps in its HTML', async () => {
    // The preloader only loads in a real browser realm, so present this one as such.
    Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
    await preloadMarkdownPipeline(async () => ({
      renderMarkdownWithMath: async (content: string) => ({
        html: `<p><strong>${content}</strong></p>`,
      }),
    }));

    const { container } = render(MarkdownPreview, { props: { content: 'hello' } });
    const preview = container.querySelector('.message-content-preview');
    expect(preview?.getAttribute('data-state')).toBe('pending');
    // Bun runs every file in one process, and the preloader caches its first pipeline, so the
    // renderer in use may belong to another file. The state, not its HTML, is what is asserted.
    await waitFor(() => expect(preview?.getAttribute('data-state')).toBe('rendered'));
  });
});

/**
 * COR-2256: while a streamed message grows, the last formatted render stays on screen until the
 * newest one lands; a slower earlier render never replaces a newer one; replacement content or a
 * new link/image policy drops straight to the escaped plain text.
 */
describe('markdown preview streamed appends', () => {
  type DeferredRender = { content: string; resolve: (html: string) => void };
  type RenderMarkdown = (content: string) => Promise<{ html: string }>;

  let restoreRenderer: (() => void) | undefined;

  afterEach(() => {
    restoreRenderer?.();
    restoreRenderer = undefined;
  });

  /**
   * Swaps the cached pipeline's renderer for one that settles only when the test says so. The
   * preloader caches one pipeline per process, so the renderer is replaced on whichever pipeline
   * is cached rather than by loading a new one.
   */
  async function installDeferredRenderer(): Promise<DeferredRender[]> {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
    const pipeline = await preloadMarkdownPipeline(async () => ({
      renderMarkdownWithMath: async (content: string) => ({ html: `<p>${content}</p>` }),
    }));
    if (pipeline === undefined) throw new Error('The markdown pipeline did not load.');
    const original = pipeline.renderMarkdownWithMath;
    const pending: DeferredRender[] = [];
    const deferred: RenderMarkdown = (content) =>
      new Promise((resolve) => {
        pending.push({ content, resolve: (html) => resolve({ html }) });
      });
    pipeline.renderMarkdownWithMath = deferred;
    restoreRenderer = () => {
      pipeline.renderMarkdownWithMath = original;
    };
    return pending;
  }

  function renderFor(pending: DeferredRender[], content: string): DeferredRender {
    const render = pending.find((entry) => entry.content === content);
    if (render === undefined) throw new Error(`No render was requested for ${content}`);
    return render;
  }

  test('keeps the previous formatted render visible while an append renders', async () => {
    const pending = await installDeferredRenderer();
    const first = 'Intro **bold**\n\n```ts\nconst a = 1;\n```';
    const view = render(MarkdownPreview, { props: { content: first } });
    const preview = view.container.querySelector('.message-content-preview');

    await waitFor(() => expect(pending.some((entry) => entry.content === first)).toBe(true));
    renderFor(pending, first).resolve(
      '<p>Intro <strong>bold</strong></p><pre><code>const a = 1;</code></pre>',
    );
    await waitFor(() => expect(preview?.getAttribute('data-state')).toBe('rendered'));

    const appended = `${first}\n\nMore text`;
    await view.rerender({ content: appended });

    // The append has not rendered yet: the previous formatted paragraph and code stay, and the
    // raw delimiters of the previous content never show.
    expect(preview?.querySelector('strong')?.textContent).toBe('bold');
    expect(preview?.querySelector('pre code')?.textContent).toBe('const a = 1;');
    expect(preview?.textContent).not.toContain('**');
    expect(preview?.textContent).not.toContain('```');
    expect(preview?.getAttribute('data-state')).toBe('pending');

    await waitFor(() => expect(pending.some((entry) => entry.content === appended)).toBe(true));
    // The newer render changes the first block's markup in place; its previous nodes must go.
    renderFor(pending, appended).resolve(
      '<p>Intro <strong>bolder</strong></p><pre><code>const a = 1;</code></pre><p>More text</p>',
    );
    await waitFor(() => expect(preview?.getAttribute('data-state')).toBe('rendered'));
    expect(preview?.textContent).toContain('More text');
    expect(preview?.querySelectorAll('strong')).toHaveLength(1);
    expect(preview?.querySelector('strong')?.textContent).toBe('bolder');
    expect(preview?.querySelectorAll('p')).toHaveLength(2);
    expect(preview?.querySelectorAll('pre')).toHaveLength(1);
  });

  test('a slower earlier render never replaces a newer one', async () => {
    const pending = await installDeferredRenderer();
    const base = 'Base **one**';
    const view = render(MarkdownPreview, { props: { content: base } });
    const preview = view.container.querySelector('.message-content-preview');

    await waitFor(() => expect(pending.some((entry) => entry.content === base)).toBe(true));
    const middle = `${base} two`;
    await view.rerender({ content: middle });
    await waitFor(() => expect(pending.some((entry) => entry.content === middle)).toBe(true));
    const latest = `${middle} three`;
    await view.rerender({ content: latest });
    await waitFor(() => expect(pending.some((entry) => entry.content === latest)).toBe(true));

    renderFor(pending, latest).resolve('<p data-render="latest">Base one two three</p>');
    await waitFor(() => expect(preview?.querySelector('[data-render="latest"]')).not.toBeNull());

    // The earlier renders settle afterwards, out of order; neither may land.
    renderFor(pending, middle).resolve('<p data-render="middle">Base one two</p>');
    renderFor(pending, base).resolve('<p data-render="base">Base one</p>');
    await quietFor(30);
    expect(preview?.querySelector('[data-render="latest"]')).not.toBeNull();
    expect(preview?.querySelector('[data-render="middle"]')).toBeNull();
    expect(preview?.querySelector('[data-render="base"]')).toBeNull();
    expect(preview?.getAttribute('data-state')).toBe('rendered');
  });

  test('replacement content shows its escaped plain text at once', async () => {
    const pending = await installDeferredRenderer();
    const first = 'First **message**';
    const view = render(MarkdownPreview, { props: { content: first } });
    const preview = view.container.querySelector('.message-content-preview');

    await waitFor(() => expect(pending.some((entry) => entry.content === first)).toBe(true));
    renderFor(pending, first).resolve('<p>First <strong>message</strong></p>');
    await waitFor(() => expect(preview?.querySelector('strong')).not.toBeNull());

    // An append starts rendering and is still in flight when the content is replaced.
    const appended = `${first} continued`;
    await view.rerender({ content: appended });
    await waitFor(() => expect(pending.some((entry) => entry.content === appended)).toBe(true));

    const replacement = 'Other <img src=x> text';
    await view.rerender({ content: replacement });

    expect(preview?.querySelector('strong')).toBeNull();
    expect(preview?.querySelector('img')).toBeNull();
    expect(preview?.querySelector('p')?.textContent).toBe(replacement);
    expect(preview?.getAttribute('data-state')).toBe('pending');

    // The superseded render settling late must not bring the previous message back.
    await waitFor(() => expect(pending.some((entry) => entry.content === replacement)).toBe(true));
    renderFor(pending, appended).resolve('<p data-render="stale">First message continued</p>');
    await quietFor(30);
    expect(preview?.querySelector('[data-render="stale"]')).toBeNull();
    expect(preview?.querySelector('p')?.textContent).toBe(replacement);
  });

  test('a fenced code block is always copyable from a floating Copy named for its language', async () => {
    const pending = await installDeferredRenderer();
    const content = '```sql\nSELECT 1;\n```';
    const view = render(MarkdownPreview, { props: { content } });
    const preview = view.container.querySelector('.message-content-preview');

    await waitFor(() => expect(pending.some((entry) => entry.content === content)).toBe(true));
    renderFor(pending, content).resolve(
      '<cinder-markdown-node data-cinder-markdown-kind="code-block" data-language="sql" data-cinder-markdown-index="0"><pre><code>SELECT 1;</code></pre></cinder-markdown-node>',
    );
    await waitFor(() => expect(preview?.querySelector('.cinder-code-block')).not.toBeNull());

    const block = preview?.querySelector('.cinder-code-block');
    expect(block?.closest('[data-cinder-markdown-node="code-block"]')).not.toBeNull();
    expect(block?.classList.contains('cinder-code-block--floating-meta')).toBe(true);
    expect(block?.querySelector('.cinder-code-block__language')).toBeNull();
    expect(block?.querySelector('.cinder-copy-button')?.getAttribute('aria-label')).toBe(
      'Copy sql code',
    );
  });

  test('turning links or images off drops the old presentation for plain text', async () => {
    const pending = await installDeferredRenderer();
    const content = 'See [docs](https://example.test/) and ![pixel](https://example.test/p.png)';
    const view = render(MarkdownPreview, { props: { content } });
    const preview = view.container.querySelector('.message-content-preview');

    await waitFor(() => expect(pending.some((entry) => entry.content === content)).toBe(true));
    renderFor(pending, content).resolve(
      '<p>See <a href="https://example.test/">docs</a> and <img src="https://example.test/p.png" alt="pixel"></p>',
    );
    await waitFor(() => expect(preview?.querySelector('a')).not.toBeNull());

    await view.rerender({ content, links: false });
    expect(preview?.querySelector('a')).toBeNull();
    expect(preview?.querySelector('img')).toBeNull();
    expect(preview?.querySelector('p')?.textContent).toBe(content);

    await view.rerender({ content, links: false, images: false });
    expect(preview?.querySelector('a')).toBeNull();
    expect(preview?.querySelector('img')).toBeNull();
    expect(preview?.querySelector('p')?.textContent).toBe(content);
  });
});
