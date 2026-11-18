/**
 * Citations at their claim (board row M4, COR-2440): a source that names the words it backs is
 * drawn as a marker in the paragraph right after them, on every width; the text is not changed,
 * and a source with no claim, or one not in the text, keeps today's placement.
 */
/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import type { CitationSource } from '@lostgradient/cinder';
import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();
const { render, cleanup, waitFor } = await import('@testing-library/svelte');
const { createRawSnippet } = await import('svelte');
const { default: MarkdownPreview, segmentRenderedMarkdown } =
  await import('./markdown-preview.svelte');
const { forgetMarkdownPipeline, preloadMarkdownPipeline } = await import('./markdown-pipeline.ts');
const { anchorClaims, claimOf, inlineCitationGroups, MAX_CLAIM_LENGTH } =
  await import('./inline-citations.ts');

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  cleanup();
  // The stand-in pipeline is forgotten, so a later file in this process starts with none.
  forgetMarkdownPipeline();
  if (originalWindowDescriptor)
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
});

const REPORT: CitationSource = {
  label: 'Annual report',
  url: 'https://example.test/annual-report',
  claim: 'Revenue grew 12% in 2025.',
};
const CALL: CitationSource = { label: 'Investor call', claim: '  Margins held at 31%.  ' };
const PLAIN: CitationSource = { label: 'Press release' };

describe('the claim a source names', () => {
  test('is checked where it enters Chat: trimmed, not empty, and bounded', () => {
    expect(claimOf(REPORT)).toBe('Revenue grew 12% in 2025.');
    expect(claimOf(CALL)).toBe('Margins held at 31%.');
    expect(claimOf(PLAIN)).toBeUndefined();
    expect(claimOf({ label: 'x', claim: '   ' })).toBeUndefined();
    expect(claimOf({ label: 'x', claim: 'x'.repeat(MAX_CLAIM_LENGTH + 1) })).toBeUndefined();
    expect(claimOf({ label: 'x', claim: 42 } as unknown as CitationSource)).toBeUndefined();
    const inherited = Object.create({ claim: 'Revenue grew' }) as CitationSource;
    expect(claimOf(inherited)).toBeUndefined();
  });

  test('groups the sources by the claim they back, in the order the claims first appear', () => {
    const second: CitationSource = { label: 'Filing', claim: 'Revenue grew 12% in 2025.' };
    expect(inlineCitationGroups([REPORT, PLAIN, CALL, second])).toEqual([
      { claim: 'Revenue grew 12% in 2025.', sources: [REPORT, second] },
      { claim: 'Margins held at 31%.', sources: [CALL] },
    ]);
    expect(inlineCitationGroups([PLAIN])).toEqual([]);
    expect(inlineCitationGroups(undefined)).toEqual([]);
  });
});

describe('a marker in the rendered text', () => {
  test('sits right after the claim, across inline markup and reflowed whitespace, and the text reads as it did', () => {
    const html =
      '<p>Revenue grew <strong>12%</strong>\nin 2025. Margins held at 31%.</p><pre><code>Revenue grew 12% in 2025.</code></pre>';
    const template = document.createElement('template');
    template.innerHTML = html;
    const textBefore = template.content.textContent;

    const anchored = anchorClaims(
      template.content,
      ['Revenue grew 12% in 2025.', 'Margins held at 31%.', 'Not in the answer.'],
      document,
    );

    expect(anchored).toEqual([0, 1]);
    expect(template.content.textContent).toBe(textBefore);
    const paragraph = template.content.querySelector('p')!;
    const anchors = [...paragraph.querySelectorAll('cinder-citation-anchor')];
    expect(anchors.map((anchor) => anchor.getAttribute('data-cinder-citation-index'))).toEqual([
      '0',
      '1',
    ]);
    expect(anchors[0]?.previousSibling?.textContent?.endsWith('in 2025.')).toBe(true);
    // Never inside code.
    expect(template.content.querySelector('pre cinder-citation-anchor')).toBeNull();
  });

  test('becomes a citation segment in its paragraph, and no claim leaves the segments as they were', () => {
    const html = '<p>Revenue grew 12% in 2025. Margins held.</p>';
    const plain = segmentRenderedMarkdown(html, document);
    expect(plain).toEqual([{ kind: 'html', html }]);

    const segments = segmentRenderedMarkdown(html, document, {
      claims: ['Revenue grew 12% in 2025.'],
    });
    expect(segments).toHaveLength(1);
    const paragraph = segments[0];
    if (paragraph?.kind !== 'element') throw new Error('Expected the paragraph element.');
    expect(paragraph.tag).toBe('p');
    expect(paragraph.children.map((child) => child.kind)).toEqual(['html', 'citation', 'html']);
    expect(paragraph.children[1]).toEqual({ kind: 'citation', index: 0 });
  });

  test('is drawn inside the rendered paragraph by the host’s marker', async () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
    await preloadMarkdownPipeline(async () => ({
      renderMarkdownWithMath: async (content: string) => ({ html: `<p>${content}</p>` }),
    }));
    const marker = createRawSnippet((index: () => number) => ({
      render: () => `<sup data-test-marker="${index()}">[1]</sup>`,
    }));

    const { container } = render(MarkdownPreview, {
      props: {
        content: 'Revenue grew 12% in 2025. Margins held.',
        citations: { claims: ['Revenue grew 12% in 2025.'], marker },
      },
    });

    const preview = container.querySelector('.message-content-preview');
    await waitFor(() => expect(preview?.getAttribute('data-state')).toBe('rendered'));
    // Bun shares one cached pipeline per process, so the paragraph is found by its marker.
    const placed = container.querySelector('[data-test-marker="0"]');
    expect(placed?.closest('p')).not.toBeNull();
    expect(placed?.closest('p')?.textContent).toContain('Margins held.');
  });
});
