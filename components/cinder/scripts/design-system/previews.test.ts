import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInThisContext } from 'node:vm';

import {
  escapePreviewScript,
  MAX_EXAMPLES,
  orderExamples,
  partition,
  planPreview,
  previewEntrySource,
} from './previews.ts';

let directory: string | undefined;

afterEach(() => {
  if (directory) removeTemporaryPath(directory);
  directory = undefined;
});

describe('planPreview', () => {
  test('reads the examples and their metadata from the component’s own workspace folder', () => {
    directory = createTemporaryDirectory('cinder-design-system-previews');
    const components = join(directory, 'editor/src/lib/components');
    const examples = join(components, 'markdown-editor/examples');
    mkdirSync(examples, { recursive: true });
    writeFileSync(join(examples, 'basic.example.svelte'), '');
    writeFileSync(join(examples, 'empty.example.svelte'), '');
    writeFileSync(
      join(components, 'markdown-editor/markdown-editor.examples.json'),
      JSON.stringify({
        examples: [
          { id: 'basic', title: 'Basic markdown editor' },
          { id: 'empty', title: 'Empty markdown editor', featured: true },
        ],
      }),
    );
    expect(planPreview('markdown-editor', components)).toEqual({
      id: 'markdown-editor',
      directory: examples,
      examples: [
        { id: 'empty', title: 'Empty markdown editor' },
        { id: 'basic', title: 'Basic markdown editor' },
      ],
    });
    expect(planPreview('diff-viewer', components)).toBeUndefined();
  });
});

describe('orderExamples', () => {
  test('puts featured examples first, then the rest, then unnamed files sorted', () => {
    const examples = orderExamples(
      ['zeta', 'basic', 'alpha', 'featured', 'sizes'],
      [
        { id: 'basic', title: 'Basic' },
        { id: 'missing', title: 'Missing', featured: true },
        { id: 'featured', title: 'Featured', featured: true },
        { id: 'sizes', title: 'Sizes' },
      ],
    );
    expect(examples).toEqual([
      { id: 'featured', title: 'Featured' },
      { id: 'basic', title: 'Basic' },
      { id: 'sizes', title: 'Sizes' },
      { id: 'alpha', title: 'alpha' },
    ]);
    expect(examples).toHaveLength(MAX_EXAMPLES);
  });
});

describe('partition', () => {
  test('deals every id into exactly one shard', () => {
    const ids = Array.from({ length: 11 }, (_, index) => `c${index}`);
    const shards = partition(ids, 4);
    expect(shards).toHaveLength(4);
    expect(shards.flat().toSorted()).toEqual(ids.toSorted());
    expect(partition(['only'], 4)).toEqual([['only']]);
  });
});

describe('escapePreviewScript', () => {
  test('escapes markup terminators and refuses a mixed-case </script', () => {
    expect(escapePreviewScript('a="</script><!--"')).toBe('a="<\\/script><\\!--"');
    expect(() => escapePreviewScript('a="</SCRIPT>"')).toThrow('</script');
  });

  test('writes every literal U+FFFD as an escape that evaluates to the same character', () => {
    const replacement = String.fromCodePoint(0xff_fd);
    // A string literal, an identity escape, an escaped backslash, and a regular-expression class.
    const code = `[${JSON.stringify(replacement)}, "\\${replacement}", "\\\\${replacement}", /[a-${replacement}]/.test(${JSON.stringify(replacement)})]`;
    const escaped = escapePreviewScript(code);
    expect(escaped).not.toContain(replacement);
    expect(escaped).toBe(String.raw`["\uFFFD", "\uFFFD", "\\\uFFFD", /[a-\uFFFD]/.test("\uFFFD")]`);
    // The escaped script means what the original did.
    expect(runInThisContext(escaped)).toEqual(runInThisContext(code));
    expect(runInThisContext(escaped)).toEqual([replacement, replacement, `\\${replacement}`, true]);
  });
});

describe('previewEntrySource', () => {
  test('imports each example and mounts it under its title', () => {
    const source = previewEntrySource({
      id: 'button',
      directory: '/button/examples',
      examples: [{ id: 'basic', title: 'Say "hi"' }],
    });
    expect(source).toContain('import E0 from "/button/examples/basic.example.svelte";');
    expect(source).toContain('{ title: "Say \\"hi\\"", component: E0 }');
    expect(source).toContain("document.getElementById('cinder-preview')");
  });
});
