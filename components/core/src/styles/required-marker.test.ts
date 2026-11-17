/**
 * The required marker is a red dot, not an asterisk (COR-1814, revision 24d).
 * Every label that marks a field required renders the shared
 * `.cinder-_required-marker` span, empty and `aria-hidden`, and
 * `_field-label.css` draws the dot. This scans every Svelte source that
 * renders the marker, so a marker that regains a `*` glyph, in markup or
 * through generated content, fails here.
 */

import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';

const source = new URL('../', import.meta.url).pathname;
const sources = new Map<string, string>();
for await (const path of new Glob('**/*.svelte').scan({ cwd: source, absolute: true })) {
  const text = await Bun.file(path).text();
  if (text.includes('cinder-_required-marker')) sources.set(path, text);
}

const MARKER =
  /<(\w+)\b[^>]*\bclass="[^"]*\bcinder-_required-marker\b[^"]*"[^>]*?(\/>|>([\s\S]*?)<\/\1>)/g;

describe('required marker', () => {
  test('every required-marker element is empty and hidden from assistive technology', async () => {
    const markers: { path: string; element: string; content: string }[] = [];
    for (const [path, text] of sources) {
      for (const match of text.matchAll(MARKER)) {
        markers.push({ path, element: match[0], content: match[3] ?? '' });
      }
    }
    expect(markers.length).toBeGreaterThanOrEqual(8);
    const offenders = markers.filter(({ content }) => content.trim() !== '');
    expect(offenders.map(({ path, element }) => `${path}: ${element}`)).toEqual([]);
    expect(markers.filter(({ element }) => !element.includes('aria-hidden="true"'))).toEqual([]);
  });

  test('no marker element contains a * glyph, in markup or generated content', async () => {
    const css = await Bun.file(new URL('./components/_field-label.css', import.meta.url)).text();
    expect(css).not.toMatch(/content:\s*['"]\*['"]/);
    for (const [path, text] of sources) {
      for (const match of text.matchAll(MARKER)) {
        expect(match[3] ?? '', path).not.toContain('*');
      }
    }
  });

  test('the marker is a 0.5rem dot in the danger solid color', async () => {
    const css = await Bun.file(new URL('./components/_field-label.css', import.meta.url)).text();
    expect(css).toContain('inline-size: 0.5rem;');
    expect(css).toContain('block-size: 0.5rem;');
    expect(css).toContain('background: var(--cinder-status-danger-solid);');
  });
});
