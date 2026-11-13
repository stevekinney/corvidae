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

  test('names the inline marker with the number of paginated sources', () => {
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

  test('clamps the current page when sources are removed', async () => {
    const { container, rerender } = render(Citation, { sources: numberedSources(7) });
    await fireEvent.click(container.querySelector('.cinder-citation__marker')!);
    await waitFor(() =>
      expect(document.querySelector('[aria-label="Next source"]')).not.toBeNull(),
    );
    for (let step = 0; step < 6; step += 1) {
      await fireEvent.click(document.querySelector('[aria-label="Next source"]')!);
    }
    await waitFor(() =>
      expect(document.querySelector('section strong')?.textContent).toBe('Source 7'),
    );
    await rerender({ sources: numberedSources(6) });
    await waitFor(() =>
      expect(document.querySelector('section strong')?.textContent).toBe('Source 6'),
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

  test('lists up to five sources together in the supplied order, with no pager', async () => {
    const sources = [
      { label: 'Second report', url: 'https://example.com/two', detail: 'Revenue rose.' },
      { label: 'First report' },
      { label: 'Second report', url: 'javascript:alert(1)' },
      { label: 'Fourth report', url: '/reports/four' },
      { label: 'Fifth report', detail: 'Costs fell.' },
    ];
    const { container } = render(Citation, { sources });
    await fireEvent.click(container.querySelector('.cinder-citation__marker')!);
    await waitFor(() => expect(document.querySelector('section ol')).not.toBeNull());

    const items = Array.from(document.querySelectorAll('section ol > li'));
    expect(items.map((item) => item.querySelector('strong')?.textContent)).toEqual([
      'Second report',
      'First report',
      'Second report',
      'Fourth report',
      'Fifth report',
    ]);
    expect(document.querySelector('.cinder-citation__pagination')).toBeNull();
    expect(document.querySelector('[aria-label="Next source"]')).toBeNull();
    expect(
      Array.from(document.querySelectorAll('section a')).map((link) => link.getAttribute('href')),
    ).toEqual(['https://example.com/two', '/reports/four']);
  });

  test('pages more than five sources one at a time', async () => {
    const { container } = render(Citation, { sources: numberedSources(6) });
    await fireEvent.click(container.querySelector('.cinder-citation__marker')!);
    await waitFor(() =>
      expect(document.querySelector('.cinder-citation__pagination')).not.toBeNull(),
    );
    expect(document.querySelector('section ol')).toBeNull();
    expect(document.querySelectorAll('section strong')).toHaveLength(1);
    expect(document.querySelector('.cinder-citation__pagination [aria-live]')?.textContent).toBe(
      '1 of 6',
    );
    await fireEvent.click(document.querySelector('[aria-label="Next source"]')!);
    await waitFor(() =>
      expect(document.querySelector('section strong')?.textContent).toBe('Source 2'),
    );
  });

  test('names a link by its host and says why a source has no link', async () => {
    const { container } = render(Citation, {
      sources: [
        { label: 'Hosted', url: 'https://docs.example.com/guide' },
        { label: 'Internal' },
        { label: 'Refused', url: 'data:text/html,hello' },
      ],
    });
    await fireEvent.click(container.querySelector('.cinder-citation__marker')!);
    await waitFor(() => expect(document.querySelector('section ol')).not.toBeNull());

    const items = Array.from(document.querySelectorAll('section ol > li'));
    const link = items[0]?.querySelector('a');
    expect(link?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Open docs.example.com ↗');
    expect(link?.querySelector('[aria-hidden="true"]')?.textContent?.trim()).toBe('↗');
    expect(items[1]?.querySelector('a')).toBeNull();
    expect(items[1]?.querySelector('.cinder-citation__note')?.textContent).toBe(
      'Internal document, no public link',
    );
    expect(items[2]?.querySelector('a')).toBeNull();
    expect(items[2]?.querySelector('.cinder-citation__note')?.textContent).toBe(
      "Link hidden: the address isn't a safe web link",
    );
  });

  test('draws the words a host passes in labels in place of its own', async () => {
    const { container } = render(Citation, {
      label: 'Quellen',
      labels: {
        open: (host: string | undefined) => `${host ?? 'Quelle'} öffnen`,
        noLink: 'Internes Dokument',
        unsafeLink: 'Link verborgen',
        previousSource: 'Vorherige Quelle',
        nextSource: 'Nächste Quelle',
        previous: 'Zurück',
        next: 'Weiter',
        position: (page: number, total: number) => `${page} von ${total}`,
      },
      sources: [
        { label: 'Eins', url: 'https://example.de/eins' },
        { label: 'Zwei' },
        { label: 'Drei', url: 'javascript:alert(1)' },
        ...numberedSources(3),
      ],
    });
    const marker = container.querySelector('.cinder-citation__marker')!;
    expect(marker.getAttribute('aria-label')).toBe('Quellen (6)');
    await fireEvent.click(marker);
    await waitFor(() =>
      expect(document.querySelector('[aria-label="Nächste Quelle"]')).not.toBeNull(),
    );
    expect(document.querySelector('[aria-label="Nächste Quelle"]')?.getAttribute('title')).toBe(
      'Weiter',
    );
    expect(document.querySelector('[aria-label="Vorherige Quelle"]')?.getAttribute('title')).toBe(
      'Zurück',
    );
    expect(
      document.querySelector('[aria-label="Nächste Quelle"] svg')?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(document.querySelector('.cinder-citation__pagination [aria-live]')?.textContent).toBe(
      '1 von 6',
    );
    expect(document.querySelector('section a')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'example.de öffnen ↗',
    );
    await fireEvent.click(document.querySelector('[aria-label="Nächste Quelle"]')!);
    await waitFor(() =>
      expect(document.querySelector('.cinder-citation__note')?.textContent).toBe(
        'Internes Dokument',
      ),
    );
    await fireEvent.click(document.querySelector('[aria-label="Nächste Quelle"]')!);
    await waitFor(() =>
      expect(document.querySelector('.cinder-citation__note')?.textContent).toBe('Link verborgen'),
    );
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

  test('renders the title, excerpt and link as separate rows in source order', async () => {
    const { container } = render(Citation, {
      sources: [{ label: 'Title', detail: 'Excerpt', url: '/sources/one' }],
    });
    await fireEvent.click(container.querySelector('.cinder-citation__marker')!);
    await waitFor(() => expect(document.querySelector('section')).not.toBeNull());
    const panel = document.querySelector('section')!;
    expect(panel.classList.contains('cinder-citation__panel')).toBe(true);
    expect(
      Array.from(panel.children).map((child) => [
        child.tagName,
        child.textContent?.replace(/\s+/g, ' ').trim(),
      ]),
    ).toEqual([
      ['STRONG', 'Title'],
      ['P', 'Excerpt'],
      ['A', 'Open source ↗'],
    ]);
    expect(panel.querySelector('strong')?.getAttribute('dir')).toBe('auto');
    expect(panel.querySelector('p')?.getAttribute('dir')).toBe('auto');
  });

  test('renders no excerpt element when the source has no detail', async () => {
    const { container } = render(Citation, { sources: [{ label: 'Refund policy' }] });
    await fireEvent.click(container.querySelector('.cinder-citation__marker')!);
    await waitFor(() => expect(document.querySelector('section')).not.toBeNull());
    expect(document.querySelector('section p')).toBeNull();
    // The title, then the note that the source has no public link: no excerpt box between them.
    expect(
      Array.from(document.querySelector('section')?.children ?? []).map((child) => child.className),
    ).toEqual(['cinder-citation__title', 'cinder-citation__note']);
  });

  test('clamps a title to two lines and wraps an excerpt in quotation marks', () => {
    const stylesheet = readFileSync(new URL('./citation.css', import.meta.url), 'utf8');
    const title = /\.cinder-citation__title \{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(title).toContain('-webkit-line-clamp: 2;');
    expect(title).toContain('line-clamp: 2;');
    expect(title).toContain('overflow: hidden;');
    expect(stylesheet).toContain('.cinder-citation__detail::before {\n    content: open-quote;');
    expect(stylesheet).toContain('.cinder-citation__detail::after {\n    content: close-quote;');
  });

  test('spaces the panel rows with a space token and wraps long strings', () => {
    const stylesheet = readFileSync(new URL('./citation.css', import.meta.url), 'utf8');
    const panel = /\.cinder-citation__panel \{[^}]*\}/.exec(stylesheet)?.[0] ?? '';

    expect(panel).toContain('flex-direction: column;');
    expect(panel).toContain('gap: var(--cinder-space-2);');
    expect(panel).toContain('overflow-wrap: anywhere;');
    expect(panel).toContain('text-align: start;');
  });

  test('keeps the reference marker visually quiet while reserving a coarse pointer target', () => {
    const stylesheet = readFileSync(new URL('./citation.css', import.meta.url), 'utf8');
    const marker = /\.cinder-citation__marker \{[^}]*\}/.exec(stylesheet)?.[0] ?? '';

    expect(marker).toContain('background: none;');
    expect(marker).toContain('border: 0;');
    expect(marker).toContain('border-radius: 0;');
    expect(marker).toContain('padding: 0;');
    expect(marker).toContain('vertical-align: baseline;');
    expect(stylesheet).toMatch(
      /@media \(any-pointer: coarse\) \{\s*\.cinder-citation__marker::before \{[^}]*var\(--cinder-touch-target-min\)/s,
    );
    expect(stylesheet).not.toMatch(/\.cinder-citation__marker \{[^}]*min-block-size/s);
    const hit = /\.cinder-citation__marker::before \{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(hit).toContain('position: absolute;');
    expect(hit).toContain('calc((100% - 24px) / 2)');
  });

  test('a standalone source link is at least 24px tall and gets its coarse hit area from a pseudo-element', () => {
    const stylesheet = readFileSync(new URL('./citation.css', import.meta.url), 'utf8');
    const link = /\n {2}\.cinder-citation__link \{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(link).toContain('min-block-size: 1.5rem;');
    expect(link).toContain('align-items: center;');
    expect(stylesheet).toMatch(
      /@media \(any-pointer: coarse\) \{[^@]*\.cinder-citation__link::before \{[^}]*var\(--cinder-touch-target-min\)/s,
    );
    expect(stylesheet).not.toMatch(/\.cinder-citation__link \{[^}]*touch-target-min/s);
  });

  test('the pager buttons get their 44px coarse hit area from a pseudo-element', () => {
    const stylesheet = readFileSync(new URL('./citation.css', import.meta.url), 'utf8');
    expect(stylesheet).toMatch(
      /@media \(any-pointer: coarse\) \{[^@]*\.cinder-citation__pagination button::before \{[^}]*position: absolute;[^}]*var\(--cinder-touch-target-min\)/s,
    );
  });

  test('the focus ring wraps the marker with 2px of padding and the compact-control radius', () => {
    const stylesheet = readFileSync(new URL('./citation.css', import.meta.url), 'utf8');
    const focus = /\.cinder-citation__marker:focus-visible \{[^}]*\}/.exec(stylesheet)?.[0] ?? '';
    expect(focus).toContain('border-radius: var(--cinder-radius-sm);');
    expect(focus).toContain('0 0 0 2px var(--cinder-ring-offset-color)');
    expect(focus).not.toContain('inset');
  });

  test('uses one compact body inset for anchored and sheet presentation', () => {
    const stylesheet = readFileSync(new URL('./citation.css', import.meta.url), 'utf8');
    const panel = /\.cinder-citation__panel \{[^}]*\}/.exec(stylesheet)?.[0] ?? '';

    expect(panel).toContain('padding: 0;');
    expect(stylesheet).toContain(
      '.cinder-popover__sheet:has(.cinder-citation__panel) .cinder-drawer__header',
    );
    expect(stylesheet).toContain('background: transparent;');
    expect(stylesheet).toContain(
      '.cinder-popover__sheet:has(.cinder-citation__panel) .cinder-drawer__body',
    );
    expect(stylesheet).not.toContain('.cinder-popover__sheet .cinder-drawer__header');
    expect(stylesheet).toContain('padding: var(--cinder-space-2) var(--cinder-space-3);');
  });

  test('composes Popover styles through the citation entry point', () => {
    const stylesheet = readFileSync(new URL('./citation.css', import.meta.url), 'utf8');

    expect(stylesheet).toContain("@import '../popover/popover.css';");
  });
});
