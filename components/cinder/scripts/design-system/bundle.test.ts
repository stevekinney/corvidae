import { describe, expect, test } from 'bun:test';

import {
  BUNDLE_NAMESPACE,
  BUNDLE_SCRIPT_CAP,
  bundleEntrySource,
  bundleHeader,
  finishBundle,
} from './bundle.ts';

describe('bundleEntrySource', () => {
  test('imports an eager source and assigns the global from each export name', () => {
    const source = bundleEntrySource('/runtime.ts', [
      { entry: '/cinder/index.ts', names: ['Button', 'Card'], lazy: false },
    ]);
    expect(source).toContain(
      'import { createCinderGlobal, lazyComponent } from "/runtime.ts";\nimport * as source0 from "/cinder/index.ts";',
    );
    expect(source).toContain('window.Cinder = createCinderGlobal({');
    expect(source).toContain('  "Button": source0["Button"],\n  "Card": source0["Card"],\n});');
    expect(source).not.toContain('import(');
  });

  test('defers a lazy source behind import() and wraps each of its components', () => {
    const source = bundleEntrySource('/runtime.ts', [
      { entry: '/cinder/index.ts', names: ['Button'], lazy: false },
      { entry: '/editor/index.ts', names: ['MarkdownEditor'], lazy: true },
    ]);
    expect(source).toContain('const source1 = () => import("/editor/index.ts");');
    expect(source).not.toContain('import * as source1');
    expect(source).toContain(
      '  "MarkdownEditor": lazyComponent(() => source1().then((module) => module["MarkdownEditor"])),',
    );
  });

  test('refuses an export name or namespace that is not an identifier', () => {
    expect(() =>
      bundleEntrySource('/runtime.ts', [{ entry: '/a.ts', names: ['Not a name'], lazy: false }]),
    ).toThrow('bad export name');
    expect(() => bundleEntrySource('/runtime.ts', [], 'window.Cinder')).toThrow(
      'bad bundle namespace',
    );
  });
});

describe('bundleHeader', () => {
  test('names the namespace and the components in order', () => {
    const header = bundleHeader(['Button', 'Card']);
    expect(header).toBe(
      '/* @ds-bundle: {"format":4,"namespace":"Cinder","components":[{"name":"Button"},{"name":"Card"}]} */\n',
    );
    expect(BUNDLE_NAMESPACE).toBe('Cinder');
  });
});

describe('finishBundle', () => {
  test('puts the header first and escapes markup terminators', () => {
    const script = finishBundle('a="</script><!--"', ['Button']);
    expect(script.startsWith(bundleHeader(['Button']))).toBe(true);
    expect(script.endsWith('a="<\\/script><\\!--"')).toBe(true);
  });

  test('refuses a bundle over the cap', () => {
    expect(() => finishBundle('x'.repeat(BUNDLE_SCRIPT_CAP), ['Button'])).toThrow('cap');
  });
});
