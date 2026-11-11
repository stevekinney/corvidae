import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildBundleCss, componentStylesheets, inlineImports, PREVIEW_LAYOUT_CSS } from './css.ts';

let directory: string | undefined;

afterEach(() => {
  if (directory) removeTemporaryPath(directory);
  directory = undefined;
});

function stylesheets(files: Record<string, string>): string {
  directory = createTemporaryDirectory('cinder-design-system-css');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(directory, name, '..'), { recursive: true });
    writeFileSync(join(directory, name), text);
  }
  return join(directory, 'all.css');
}

describe('inlineImports', () => {
  test('inlines imports in place, wraps layered ones, and inlines a repeat once', () => {
    const entry = stylesheets({
      'all.css':
        "@import './tokens.css' layer(cinder.tokens);\n@import './parts/a.css';\n@import './tokens.css';\n",
      'tokens.css': ':root { --x: light-dark(red, blue); }',
      'parts/a.css': "@import '../tokens.css';\n.a {}",
    });
    expect(inlineImports(entry)).toBe(
      // The final import's own newline is part of the matched line, as it was in the original.
      '@layer cinder.tokens {\n:root { --x: light-dark(red, blue); }\n}\n\n.a {}\n',
    );
  });
});

describe('buildBundleCss', () => {
  test('appends the preview layout and refuses a </style', () => {
    const entry = stylesheets({ 'all.css': '.a {}\n' });
    expect(buildBundleCss(entry)).toBe(`.a {}\n${PREVIEW_LAYOUT_CSS}`);
    writeFileSync(entry, '.a { content: "</style>"; }\n');
    expect(() => buildBundleCss(entry)).toThrow('</style');
  });

  test('inlines further stylesheets after the entry, each once', () => {
    const entry = stylesheets({
      'all.css': "@import './shared.css';\n.a {}\n",
      'shared.css': '.shared {}',
      'editor/markdown-editor/prosemirror.css': '.prose {}\n',
    });
    const root = join(entry, '..');
    expect(
      buildBundleCss(entry, [
        join(root, 'editor/markdown-editor/prosemirror.css'),
        join(root, 'shared.css'),
      ]),
    ).toBe(`.shared {}\n.a {}\n.prose {}\n${PREVIEW_LAYOUT_CSS}`);
  });
});

describe('componentStylesheets', () => {
  test('lists each component folder’s stylesheets in id order, skipping a missing folder', () => {
    const entry = stylesheets({
      'all.css': '',
      'components/review-editor/review-editor.css': '',
      'components/review-editor/index.ts': '',
      'components/markdown-editor/prosemirror.css': '',
      'components/markdown-editor/b.css': '',
    });
    const components = join(entry, '..', 'components');
    expect(
      componentStylesheets(components, ['markdown-editor', 'diff-viewer', 'review-editor']),
    ).toEqual([
      join(components, 'markdown-editor/b.css'),
      join(components, 'markdown-editor/prosemirror.css'),
      join(components, 'review-editor/review-editor.css'),
    ]);
  });
});
