/// <reference lib="dom" />
import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { staticArtifactDocument, wrapSvgInHtml } from './artifact-static-document.ts';
import ArtifactViewer from './artifact-viewer.svelte';

function parse(documentSource: string): Document {
  return new DOMParser().parseFromString(documentSource, 'text/html');
}

describe('static artifact documents', () => {
  test('put the policy first, so markup in the artifact cannot precede or replace it', () => {
    const output = staticArtifactDocument(
      `<head><meta http-equiv="Content-Security-Policy" content="default-src *"><title>T</title></head><body><p>Hello</p></body>`,
    );
    const parsed = parse(output);
    const first = parsed.head.firstElementChild;
    expect(first?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(first?.getAttribute('content')).toContain("default-src 'none'");
    expect(first?.getAttribute('content')).toContain("base-uri 'none'");
    expect(parsed.body.textContent).toContain('Hello');
    // Whatever the artifact adds comes after ours; policies intersect, so it can only tighten.
    expect(output.indexOf("default-src 'none'")).toBeLessThan(output.indexOf('default-src *'));
  });

  test('removes elements that fetch a subresource or retarget the document', () => {
    const parsed = parse(
      staticArtifactDocument(`<!DOCTYPE html><html><head>
        <base href="https://example.test/">
        <link rel="stylesheet" href="https://example.test/a.css">
        <meta http-equiv="refresh" content="0;url=https://example.test/">
        <meta http-equiv=" Refresh " content="0">
        <meta charset="utf-8">
      </head><body>
        <img src="https://example.test/a.png" alt="Remote">
        <iframe src="https://example.test/"></iframe><object data="https://example.test/o"></object>
        <embed src="https://example.test/e"><video src="data:video/mp4;base64,AA"></video>
        <script>alert(1)</script><template><img src="https://example.test/t.png"></template>
        <p>Static text</p>
      </body></html>`),
    );
    for (const selector of [
      'base',
      'link',
      'img',
      'iframe',
      'object',
      'embed',
      'video',
      'script',
      'template',
      'meta[http-equiv="refresh" i]',
    ]) {
      expect(parsed.querySelectorAll(selector).length, selector).toBe(0);
    }
    expect(parsed.querySelector('meta[charset]')).not.toBeNull();
    expect(parsed.body.textContent).toContain('Static text');
  });

  test('keeps authored link text but removes every link target', () => {
    const parsed = parse(
      staticArtifactDocument(
        `<a href="https://example.test/" target="_blank">Remote</a><a href="/same">Same</a><a href="relative">Relative</a><a href="#top">Fragment</a><map><area href="https://example.test/" alt="Area"></map><svg><a href="https://example.test/" xlink:href="https://example.test/"><text>Vector link</text></a></svg>`,
      ),
    );
    const links = Array.from(parsed.querySelectorAll('a, area'));
    expect(links.length).toBe(6);
    for (const link of links) {
      expect(link.getAttributeNames().filter((name) => /href|target/i.test(name))).toEqual([]);
    }
    expect(parsed.body.textContent).toContain('Remote');
    expect(parsed.body.textContent).toContain('Vector link');
  });

  test('strips inline vector subresources but keeps local fragment references and geometry', () => {
    const parsed = parse(
      staticArtifactDocument(
        wrapSvgInHtml(
          `<svg viewBox="0 0 10 10"><defs><circle id="dot" r="2" cx="2" cy="2"/></defs><use href="#dot"/><use xlink:href="#dot"/><use href="https://example.test/s.svg#dot"/><use href="data:image/svg+xml,%3Csvg/%3E"/><image href="https://example.test/i.png"/><feImage href="blob:https://example.test/x"/><use href="#dot"><set attributeName="href" to="https://example.test/s.svg#dot"/></use><rect width="4" height="4" style="fill:red"/></svg>`,
        ),
      ),
    );
    const uses = Array.from(parsed.querySelectorAll('use'));
    expect(uses.length).toBe(5);
    const referencing = uses.filter(
      (use) => use.hasAttribute('href') || use.hasAttribute('xlink:href'),
    );
    expect(referencing).toHaveLength(3);
    expect(
      referencing.every(
        (use) => (use.getAttribute('href') ?? use.getAttribute('xlink:href')) === '#dot',
      ),
    ).toBe(true);
    expect(parsed.querySelector('image, feImage, set')).toBeNull();
    expect(parsed.querySelector('circle')?.getAttribute('r')).toBe('2');
    expect(parsed.querySelector('rect')?.getAttribute('style')).toBe('fill:red');
  });

  test('renders into a sandboxed frame without scripts and carries the policy', () => {
    const { container } = render(ArtifactViewer, {
      props: { type: 'html', content: '<a href="https://example.test/">Link</a>' },
    });
    const frame = container.querySelector('iframe');
    expect(frame?.getAttribute('sandbox')).toBe('');
    const source = frame?.getAttribute('srcdoc') ?? '';
    expect(source).toContain("default-src 'none'");
    expect(source).toContain('Link');
    expect(source).not.toContain('https://example.test/');
  });
});
