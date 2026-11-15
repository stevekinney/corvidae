/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

// setupHappyDom() MUST run before any `@testing-library/svelte` import. testing-library
// reads `globalThis.document` / `window` at module-init (top-level, not inside test bodies),
// so we register happy-dom's globals first and then dynamic-import testing-library below.
setupHappyDom();

const { cleanup, render, fireEvent, waitFor } = await import('@testing-library/svelte');
const { default: Citation } = await import('./citation.svelte');
// createRawSnippet must be imported dynamically so Bun's svelte plugin (which patches
// the svelte package to resolve to the client build) applies before this import resolves.
// A top-level static import of 'svelte' resolves to svelte/index-server.js in Bun's
// non-browser environment, making `mount()` throw "not available on the server".
const { createRawSnippet, flushSync } = await import('svelte');

afterEach(cleanup);

/** Creates a Svelte 5 Snippet that renders text content. */
function textSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<span>${text}</span>`,
  }));
}

/** `count` text-only sources named "Source 1" to "Source <count>". */
function numberedSources(count: number) {
  return Array.from({ length: count }, (_, index) => ({ label: `Source ${index + 1}` }));
}

function stylesheet(): string {
  return readFileSync(new URL('./citation.css', import.meta.url), 'utf8');
}

describe('Citation', () => {
  test('renders custom marker children inside the trigger without the default marker', () => {
    const { container } = render(Citation, { sources: [], children: textSnippet('content') });
    const element = container.querySelector('.cinder-citation');
    const marker = container.querySelector('.cinder-citation__marker');
    expect(element).not.toBeNull();
    expect(marker?.textContent).toBe('content');
    expect(element?.textContent).not.toContain('[0]');
  });

  test('merges a custom class alongside cinder-citation', () => {
    const { container } = render(Citation, {
      children: textSnippet('content'),
      sources: [],
      class: 'my-custom-class',
    });
    const element = container.querySelector('.cinder-citation');
    expect(element?.getAttribute('class')).toContain('cinder-citation');
    expect(element?.getAttribute('class')).toContain('my-custom-class');
  });

  test('names the inline marker with the number of sources', () => {
    const { container } = render(Citation, {
      label: 'References',
      sources: [
        { label: 'Primary source', url: 'https://example.com/one' },
        { label: 'Second source', detail: 'Supporting context' },
      ],
    });
    const marker = container.querySelector('.cinder-citation__marker');
    expect(marker?.getAttribute('aria-label')).toBe('References (2)');
    expect(marker?.textContent).toBe('[2]');
  });

  test('disables the marker when there are no sources', async () => {
    const { container } = render(Citation, { sources: [] });
    const marker = requiredInstance(
      container.querySelector('.cinder-citation__marker'),
      HTMLButtonElement,
    );
    expect(marker.disabled).toBe(true);
    expect(marker.getAttribute('aria-label')).toBe('Sources (no sources)');
    await fireEvent.click(marker);
    expect(document.querySelector('section')).toBeNull();
  });

  test('renders only safe HTTP or relative source links', async () => {
    const { container, rerender } = render(Citation, {
      sources: [{ label: 'Unsafe source', url: 'javascript:alert(1)' }],
    });
    await fireEvent.click(container.querySelector('.cinder-citation__marker')!);
    await waitFor(() => expect(document.querySelector('section strong')).not.toBeNull());
    expect(document.querySelector('section a')).toBeNull();

    await rerender({ sources: [{ label: 'Safe source', url: '/sources/one' }] });
    await waitFor(() =>
      expect(document.querySelector('section a')?.getAttribute('href')).toBe('/sources/one'),
    );
  });

  test('closes an open panel when a host withdraws a displayed source', async () => {
    const { container, rerender } = render(Citation, {
      closeOnSourceRemoval: true,
      sources: [{ label: 'First' }, { label: 'Second' }],
    });
    await fireEvent.click(container.querySelector('.cinder-citation__marker')!);
    await waitFor(() => expect(document.querySelector('.cinder-citation__panel')).not.toBeNull());

    await rerender({
      closeOnSourceRemoval: true,
      sources: [{ label: 'Second' }],
    });
    await waitFor(() =>
      expect(document.querySelector('.cinder-citation__panel')?.outerHTML ?? null).toBeNull(),
    );
  });

  test('lists every source in the supplied order, however many there are, with no pager', async () => {
    const { container } = render(Citation, { sources: numberedSources(8) });
    await fireEvent.click(container.querySelector('.cinder-citation__marker')!);
    await waitFor(() => expect(document.querySelector('section ol')).not.toBeNull());

    expect(
      Array.from(document.querySelectorAll('section ol > li')).map(
        (item) => item.querySelector('strong')?.textContent,
      ),
    ).toEqual(numberedSources(8).map((source) => source.label));
    expect(document.querySelector('.cinder-citation__pagination')).toBeNull();
    expect(document.querySelector('[aria-label="Next source"]')).toBeNull();
    expect(document.querySelector('section')?.textContent).not.toMatch(/\d of \d/);
  });

  test('a single source is still a list of one row', async () => {
    const { container } = render(Citation, { sources: [{ label: 'Only', url: '/only' }] });
    await fireEvent.click(container.querySelector('.cinder-citation__marker')!);
    await waitFor(() => expect(document.querySelector('section ol > li')).not.toBeNull());
    expect(document.querySelectorAll('section ol > li')).toHaveLength(1);
  });

  test('a linked source is one link row: title, domain, excerpt and a trailing open glyph', async () => {
    const { container } = render(Citation, {
      sources: [
        {
          label: 'Hosted',
          url: 'https://docs.example.com/guide',
          detail: 'The guide says so.',
        },
      ],
    });
    await fireEvent.click(container.querySelector('.cinder-citation__marker')!);
    await waitFor(() => expect(document.querySelector('section ol')).not.toBeNull());

    const row = document.querySelector('section ol > li > a')!;
    expect(row.getAttribute('href')).toBe('https://docs.example.com/guide');
    expect(row.querySelector('.cinder-citation__title')?.textContent).toBe('Hosted');
    expect(row.querySelector('.cinder-citation__title')?.getAttribute('dir')).toBe('auto');
    expect(row.querySelector('.cinder-citation__domain')?.textContent).toBe('docs.example.com');
    expect(row.querySelector('.cinder-citation__detail')?.textContent).toBe('The guide says so.');
    const glyph = row.lastElementChild!;
    expect(glyph.tagName.toLowerCase()).toBe('svg');
    expect(glyph.getAttribute('aria-hidden')).toBe('true');
    // The whole row is the link: no separate "Open ..." link and no arrow character.
    expect(document.querySelectorAll('section a')).toHaveLength(1);
    expect(document.querySelector('section')?.textContent).not.toContain('Open ');
    expect(document.querySelector('section')?.textContent).not.toContain('↗');
  });

  test('says why a source has no link, and is not a link', async () => {
    const { container } = render(Citation, {
      sources: [
        { label: 'Internal', detail: 'Notes' },
        { label: 'Refused', url: 'data:text/html,hello' },
      ],
    });
    await fireEvent.click(container.querySelector('.cinder-citation__marker')!);
    await waitFor(() => expect(document.querySelector('section ol')).not.toBeNull());

    const items = Array.from(document.querySelectorAll('section ol > li'));
    expect(document.querySelector('section a')).toBeNull();
    expect(items[0]?.querySelector('.cinder-citation__note')?.textContent).toBe(
      'Internal document, no public link',
    );
    expect(items[0]?.querySelector('svg')).toBeNull();
    expect(items[1]?.querySelector('.cinder-citation__note')?.textContent).toBe(
      "Link hidden: the address isn't a safe web link",
    );
    expect(items[1]?.querySelector('svg')).toBeNull();
  });

  test('marks the cited row as current and scrolls it into view when the list opens', async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      const { container } = render(Citation, {
        sources: numberedSources(6),
        current: 4,
      });
      await fireEvent.click(container.querySelector('.cinder-citation__marker')!);
      await waitFor(() => expect(document.querySelector('section ol')).not.toBeNull());

      const rows = Array.from(document.querySelectorAll('section ol > li > .cinder-citation__row'));
      expect(rows.map((row) => row.getAttribute('aria-current'))).toEqual([
        null,
        null,
        null,
        null,
        'true',
        null,
      ]);
      await waitFor(() => expect(scrolled).toHaveLength(1));
      expect(scrolled[0]?.querySelector('.cinder-citation__title')?.textContent).toBe('Source 5');
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  test('marks no row when current is absent or out of range', async () => {
    const { container, rerender } = render(Citation, { sources: numberedSources(3) });
    await fireEvent.click(container.querySelector('.cinder-citation__marker')!);
    await waitFor(() => expect(document.querySelector('section ol')).not.toBeNull());
    expect(document.querySelector('[aria-current]')).toBeNull();
    await rerender({ sources: numberedSources(3), current: 9 });
    expect(document.querySelector('[aria-current]')).toBeNull();
  });

  test('draws the words a host passes in labels in place of its own', async () => {
    const { container } = render(Citation, {
      label: 'Quellen',
      labels: { noLink: 'Internes Dokument', unsafeLink: 'Link verborgen' },
      sources: [{ label: 'Zwei' }, { label: 'Drei', url: 'javascript:alert(1)' }],
    });
    const marker = container.querySelector('.cinder-citation__marker')!;
    expect(marker.getAttribute('aria-label')).toBe('Quellen (2)');
    await fireEvent.click(marker);
    await waitFor(() => expect(document.querySelector('section ol')).not.toBeNull());
    expect(
      Array.from(document.querySelectorAll('.cinder-citation__note')).map(
        (note) => note.textContent,
      ),
    ).toEqual(['Internes Dokument', 'Link verborgen']);
  });

  test('names an empty marker with the translated no-sources word', () => {
    const { container } = render(Citation, {
      label: 'Quellen',
      labels: { noSources: 'keine Quellen' },
      sources: [],
    });
    expect(container.querySelector('.cinder-citation__marker')?.getAttribute('aria-label')).toBe(
      'Quellen (keine Quellen)',
    );
  });

  test('closes when sources become empty and stays closed when replenished', async () => {
    const { container, rerender } = render(Citation, {
      sources: [{ label: 'One' }],
    });
    await fireEvent.click(container.querySelector('.cinder-citation__marker')!);
    await waitFor(() => expect(document.querySelector('section strong')).not.toBeNull());

    await rerender({ sources: [] });
    flushSync();
    expect(document.querySelector('section')?.outerHTML ?? null).toBeNull();
    await rerender({ sources: [{ label: 'Replenished' }] });
    expect(document.querySelector('section')).toBeNull();
  });

  test('restores focus to the citation marker when open sources become empty', async () => {
    const { container, rerender } = render(Citation, {
      sources: [{ label: 'One' }],
    });
    const marker = container.querySelector<HTMLButtonElement>('.cinder-citation__marker')!;

    await fireEvent.click(marker);
    await waitFor(() => expect(document.querySelector('section strong')).not.toBeNull());
    await rerender({ sources: [] });
    flushSync();
    expect(document.querySelector('section')?.outerHTML ?? null).toBeNull();

    expect(document.activeElement).toBe(marker);
  });

  test('renders no excerpt element when the source has no detail', async () => {
    const { container } = render(Citation, { sources: [{ label: 'Refund policy' }] });
    await fireEvent.click(container.querySelector('.cinder-citation__marker')!);
    await waitFor(() => expect(document.querySelector('section')).not.toBeNull());
    expect(document.querySelector('.cinder-citation__detail')).toBeNull();
  });

  describe('inPlace', () => {
    test('opens the list under the marker, with the expanded state on the marker', async () => {
      const changes: boolean[] = [];
      const { container } = render(Citation, {
        sources: numberedSources(3),
        inPlace: true,
        onExpandedChange: (expanded: boolean) => changes.push(expanded),
      });
      const marker = container.querySelector<HTMLButtonElement>('.cinder-citation__marker')!;
      expect(marker.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelector('section')).toBeNull();

      await fireEvent.click(marker);
      const panel = container.querySelector('section')!;
      expect(panel.classList.contains('cinder-citation__panel')).toBe(true);
      expect(container.querySelector('.cinder-citation--in-place')).not.toBeNull();
      expect(marker.getAttribute('aria-expanded')).toBe('true');
      expect(marker.getAttribute('aria-controls')).toBe(panel.id);
      expect(panel.querySelectorAll('ol > li')).toHaveLength(3);
      expect(changes).toEqual([true]);

      await fireEvent.click(marker);
      expect(container.querySelector('section')).toBeNull();
      expect(marker.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement === marker || document.activeElement === document.body).toBe(
        true,
      );
      expect(changes).toEqual([true, false]);
    });

    test('follows a host that drives expanded', async () => {
      const { container, rerender } = render(Citation, {
        sources: numberedSources(2),
        inPlace: true,
        expanded: true,
      });
      expect(container.querySelector('section ol')).not.toBeNull();
      await rerender({ sources: numberedSources(2), inPlace: true, expanded: false });
      expect(container.querySelector('section')).toBeNull();
    });
  });

  test('clamps a title to two lines and wraps an excerpt in quotation marks', () => {
    const css = stylesheet();
    const title = /\.cinder-citation__title \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(title).toContain('-webkit-line-clamp: 2;');
    expect(title).toContain('line-clamp: 2;');
    expect(title).toContain('overflow: hidden;');
    expect(css).toContain('.cinder-citation__detail::before {\n    content: open-quote;');
    expect(css).toContain('.cinder-citation__detail::after {\n    content: close-quote;');
  });

  test('caps the panel at about half the viewport and scrolls the list inside it', () => {
    const css = stylesheet();
    const panel = /\.cinder-citation__panel \{[^}]*\}/.exec(css)?.[0] ?? '';

    expect(panel).toContain('max-block-size: 50dvh;');
    expect(panel).toContain('overflow-y: auto;');
    expect(panel).toContain('overflow-wrap: anywhere;');
    expect(panel).toContain('text-align: start;');
  });

  test('keeps the list inside the panel: the rows overhang through the panel, not the list', () => {
    const css = stylesheet();
    const panel = /\.cinder-citation__panel \{[^}]*\}/.exec(css)?.[0] ?? '';
    const list = /\.cinder-citation__list \{[^}]*\}/.exec(css)?.[0] ?? '';
    const item = /\.cinder-citation__item \{[^}]*\}/.exec(css)?.[0] ?? '';

    expect(panel).toContain('--_cinder-citation-row-inset: calc(var(--cinder-space-2) + 2px);');
    expect(panel).toContain('margin-inline: calc(-1 * var(--_cinder-citation-row-inset));');
    expect(panel).toContain('padding-inline: var(--_cinder-citation-row-inset);');
    // A negative margin on the list would make it wider than the panel and scroll it sideways.
    expect(list).toContain('margin: 0;');
    // The foundation's list-item bottom margin would leave a gap under every row.
    expect(item).toContain('margin: 0;');
  });

  test('marks the current row with an edge and a face, not colour alone', () => {
    const css = stylesheet();
    const current = /\.cinder-citation__row\[aria-current='true'\] \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(current).toContain('border-inline-start-color');
    expect(current).toContain('background:');
  });

  test('keeps the reference marker visually quiet while reserving a coarse pointer target', () => {
    const css = stylesheet();
    const marker = /\.cinder-citation__marker \{[^}]*\}/.exec(css)?.[0] ?? '';

    expect(marker).toContain('background: none;');
    expect(marker).toContain('border: 0;');
    expect(marker).toContain('border-radius: 0;');
    expect(marker).toContain('padding: 0;');
    expect(marker).toContain('vertical-align: baseline;');
    expect(css).toMatch(
      /@media \(any-pointer: coarse\) \{\s*\.cinder-citation__marker::before \{[^}]*var\(--cinder-touch-target-min\)/s,
    );
    expect(css).not.toMatch(/\.cinder-citation__marker \{[^}]*min-block-size/s);
    const hit = /\.cinder-citation__marker::before \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(hit).toContain('position: absolute;');
    expect(hit).toContain('calc((100% - 24px) / 2)');
  });

  test('the open glyph is smaller than the title line so it never makes a row taller', () => {
    const css = stylesheet();
    const glyph = /svg\.cinder-citation__glyph \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(glyph).toContain('inline-size: 0.875rem;');
    expect(glyph).toContain('block-size: 0.875rem;');
  });

  test('the focus ring wraps the marker with 2px of padding and the compact-control radius', () => {
    const css = stylesheet();
    const focus = /\.cinder-citation__marker:focus-visible \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(focus).toContain('border-radius: var(--cinder-radius-sm);');
    expect(focus).toContain('0 0 0 2px var(--cinder-ring-offset-color)');
    expect(focus).not.toContain('inset');
  });

  test('uses one compact body inset for anchored and sheet presentation', () => {
    const css = stylesheet();
    const panel = /\.cinder-citation__panel \{[^}]*\}/.exec(css)?.[0] ?? '';

    expect(panel).toContain('padding-block: 0;');
    expect(css).toContain(
      '.cinder-popover__sheet:has(.cinder-citation__panel) .cinder-drawer__header',
    );
    expect(css).toContain('background: transparent;');
    expect(css).toContain(
      '.cinder-popover__sheet:has(.cinder-citation__panel) .cinder-drawer__body',
    );
    expect(css).not.toContain('.cinder-popover__sheet .cinder-drawer__header');
    expect(css).toContain('padding: var(--cinder-space-2) var(--cinder-space-3);');
  });

  test('composes Popover styles through the citation entry point', () => {
    expect(stylesheet()).toContain("@import '../popover/popover.css';");
  });
});
