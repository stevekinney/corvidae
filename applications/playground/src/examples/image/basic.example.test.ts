import { expect, test } from 'bun:test';

import { imageExamples } from '@lostgradient/cinder';

// An `<img>` renders its SVG as a separate document, so `currentColor` there never
// follows the host theme: the illustration went near-black on the dark theme (CIN-61).
// It carries explicit opaque colors instead.
const authoredSource = await Bun.file(new URL('./basic.example.svelte', import.meta.url)).text();

function illustrationMarkup(source: string): string {
  const match = /"data:image\/svg\+xml,([^"]+)"/.exec(source);
  if (match?.[1] === undefined) throw new Error('The Image example has no SVG data URI source.');
  return decodeURIComponent(match[1]);
}

function shapeFills(markup: string): Record<string, string> {
  const fills: Record<string, string> = {};
  for (const shape of markup.matchAll(/<(rect|path|circle)\b([^>]*)\/>/g)) {
    const [, element, attributes] = shape;
    if (element === undefined || attributes === undefined) continue;
    expect(attributes, `${element} must not dim itself with opacity`).not.toContain('opacity');
    fills[element] = /\bfill='([^']*)'/.exec(attributes)?.[1] ?? 'missing';
  }
  return fills;
}

test('the illustration paints every shape with an explicit opaque color', () => {
  const markup = illustrationMarkup(authoredSource);
  expect(markup).not.toContain('currentColor');
  expect(shapeFills(markup)).toEqual({ rect: '#f1f5f9', path: '#0f172a', circle: '#0f172a' });
});

test('the illustration keeps its 600x338 canvas, 16:9 ratio, and alternative text', () => {
  const markup = illustrationMarkup(authoredSource);
  expect(markup).toContain("width='600' height='338' viewBox='0 0 600 338'");
  expect(authoredSource).toContain('alt="An illustration of mountains beneath a sun"');
  expect(authoredSource).toContain('ratio="16/9"');
  expect(authoredSource).toContain('width={600}');
  expect(authoredSource).toContain('height={338}');
});

test('the committed examples artifact matches the authored example', () => {
  const [basic] = imageExamples.examples;
  const authoredBody = authoredSource.replace(
    /^<script lang="ts" module>[\s\S]*?<\/script>\n\n/,
    '',
  );
  expect(authoredBody).not.toBe(authoredSource);
  expect(basic?.id).toBe('basic');
  expect(basic?.code).toBe(authoredBody);
});
