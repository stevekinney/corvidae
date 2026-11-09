import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildBundleCss, inlineImports, PREVIEW_LAYOUT_CSS } from './css.ts';

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
});
