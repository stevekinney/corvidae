import { describe, expect, it } from 'bun:test';

import {
  addReadmeHeadingAnchors,
  readmeAnchorId,
  rewriteReadmeFragmentLinks,
  slugifyHeadingText,
} from './readme-anchors.ts';

describe('slugifyHeadingText', () => {
  // READMEs are authored for GitHub, so their fragment links use GitHub's heading slugs.
  it('lowercases, drops punctuation, and joins words with hyphens as GitHub does', () => {
    expect(slugifyHeadingText('Usage')).toBe('usage');
    expect(slugifyHeadingText('Layout and sizing')).toBe('layout-and-sizing');
    expect(slugifyHeadingText('Header focus, resize, and reorder by keyboard')).toBe(
      'header-focus-resize-and-reorder-by-keyboard',
    );
    expect(slugifyHeadingText('Why `onStateChange`, not `onChange`?')).toBe(
      'why-onstatechange-not-onchange',
    );
  });

  it('keeps hyphens, underscores, digits, and letters of any script', () => {
    expect(slugifyHeadingText('Step 2: snake_case-and-kebab')).toBe('step-2-snake_case-and-kebab');
    expect(slugifyHeadingText('Éléments')).toBe('éléments');
  });

  it('leaves a space for each dropped character between words, as GitHub does', () => {
    expect(slugifyHeadingText('Props & events')).toBe('props--events');
  });
});

describe('addReadmeHeadingAnchors', () => {
  it('gives every heading level an id in the README namespace', () => {
    const html = addReadmeHeadingAnchors(
      '<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>',
    );

    for (const [level, name] of [
      [1, 'one'],
      [2, 'two'],
      [3, 'three'],
      [4, 'four'],
      [5, 'five'],
      [6, 'six'],
    ] as const) {
      expect(html).toContain(`<h${level} id="readme-${name}">`);
    }
  });

  // The page owns `#overview`, `#guidance`, `#examples`, `#props`, `#accessibility`, and
  // `#related` (the sections the scroll spy follows), and 50 READMEs carry a heading with one of
  // those names. An unprefixed README id would be a duplicate id in the same document.
  it('prefixes the id so a README heading never takes a name the page owns', () => {
    const html = addReadmeHeadingAnchors('<h2>Accessibility</h2><h2>Guidance</h2>');

    expect(html).toBe(
      '<h2 id="readme-accessibility">Accessibility</h2><h2 id="readme-guidance">Guidance</h2>',
    );
  });

  it('reads the slug from the heading text, not its inline markup', () => {
    const html = addReadmeHeadingAnchors(
      '<h2><code>onclick</code> and <em>focus</em> handling</h2>',
    );

    expect(html).toContain('id="readme-onclick-and-focus-handling"');
  });

  it('decodes the entities the renderer escapes before slugging', () => {
    const html = addReadmeHeadingAnchors('<h2>Q&amp;A &lt;slot&gt;</h2>');

    expect(html).toContain('id="readme-qa-slot"');
  });

  it('numbers a repeated heading the way GitHub does', () => {
    const html = addReadmeHeadingAnchors('<h2>Usage</h2><h3>Usage</h3><h3>Usage</h3>');

    expect(html).toBe(
      '<h2 id="readme-usage">Usage</h2><h3 id="readme-usage-1">Usage</h3><h3 id="readme-usage-2">Usage</h3>',
    );
  });

  it('does not reuse an id that a numbered repeat already took', () => {
    const html = addReadmeHeadingAnchors('<h2>Usage</h2><h2>Usage 1</h2><h2>Usage</h2>');

    const ids = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('leaves a heading that already has an id alone', () => {
    const html = addReadmeHeadingAnchors('<h2 id="custom">Usage</h2>');

    expect(html).toBe('<h2 id="custom">Usage</h2>');
  });

  it('leaves a heading whose text has nothing to slug without an id', () => {
    expect(addReadmeHeadingAnchors('<h2>🙂</h2>')).toBe('<h2>🙂</h2>');
  });

  it('does not treat a heading tag shown as escaped text as a heading', () => {
    const html = '<p>Use <code>&lt;h2&gt;Usage&lt;/h2&gt;</code> for sections.</p>';

    expect(addReadmeHeadingAnchors(html)).toBe(html);
  });
});

describe('rewriteReadmeFragmentLinks', () => {
  it("points a link at a heading of the same README at that heading's README id", () => {
    const html = addReadmeHeadingAnchors('<h2>Editing</h2><p><a href="#editing">Editing</a></p>');

    expect(rewriteReadmeFragmentLinks(html)).toContain('<a href="#readme-editing">Editing</a>');
  });

  it('keeps the other attributes of the link', () => {
    const html = addReadmeHeadingAnchors(
      '<h2>Editing</h2><a class="x" href="#editing" data-y="z">Editing</a>',
    );

    expect(rewriteReadmeFragmentLinks(html)).toContain(
      '<a class="x" href="#readme-editing" data-y="z">',
    );
  });

  // Footnote links and anything else the page or the renderer owns point at ids this module did not
  // create, so only a fragment that names a heading of this README is rewritten.
  it('leaves a fragment that names no heading of the README alone', () => {
    const html = addReadmeHeadingAnchors(
      '<h2>Usage</h2><a href="#user-content-fn-1">1</a><a href="#props">Props</a>',
    );

    const rewritten = rewriteReadmeFragmentLinks(html);

    expect(rewritten).toContain('<a href="#user-content-fn-1">');
    expect(rewritten).toContain('<a href="#props">');
  });

  it('leaves links that are not fragment links alone', () => {
    const html = addReadmeHeadingAnchors(
      '<h2>Usage</h2><a href="/page/table#usage">a</a><a href="https://example.com/#usage">b</a>',
    );

    const rewritten = rewriteReadmeFragmentLinks(html);

    expect(rewritten).toContain('<a href="/page/table#usage">');
    expect(rewritten).toContain('<a href="https://example.com/#usage">');
  });
});

describe('readmeAnchorId', () => {
  it('namespaces a fragment the same way a heading id is namespaced', () => {
    const [, id] = /id="([^"]+)"/.exec(addReadmeHeadingAnchors('<h2>Usage</h2>')) ?? [];

    expect(readmeAnchorId('usage')).toBe(id);
  });
});
