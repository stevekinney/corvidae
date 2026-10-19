/**
 * The registries Chat's highlighter reads in the built application: they must hold the grammars
 * and themes the transcript needs, and each loader must give Shiki something it can register.
 */
import { describe, expect, test } from 'bun:test';

import { bundledLanguages, bundledThemes } from './curated-shiki-registries.ts';

describe('the curated language registry', () => {
  test('holds JSON, which every tool call’s arguments and result are shown in', async () => {
    const loader = bundledLanguages.json;

    const grammar = await loader();

    expect(Array.isArray(grammar.default)).toBe(true);
    expect(grammar.default.length).toBeGreaterThan(0);
  });

  test('gives Shiki a grammar for every language it names', async () => {
    const loaded = await Promise.all(
      Object.entries(bundledLanguages).map(async ([name, load]) => [name, await load()] as const),
    );

    for (const [name, grammar] of loaded) {
      expect(Array.isArray(grammar.default), name).toBe(true);
      expect(grammar.default.length, name).toBeGreaterThan(0);
    }
  });

  test('holds the languages Markdown highlights', () => {
    for (const language of [
      'typescript',
      'javascript',
      'python',
      'sql',
      'bash',
      'json',
      'yaml',
      'markdown',
      'svelte',
      'css',
      'html',
      'diff',
    ]) {
      expect(Object.keys(bundledLanguages), language).toContain(language);
    }
  });

  test('answers to the short names a fence uses', () => {
    expect(bundledLanguages.ts).toBe(bundledLanguages.typescript);
    expect(bundledLanguages.sh).toBe(bundledLanguages.shellscript);
    expect(bundledLanguages.yml).toBe(bundledLanguages.yaml);
  });
});

describe('the curated theme registry', () => {
  test('holds the light and dark themes the console highlights with', async () => {
    expect(Object.keys(bundledThemes).toSorted()).toEqual(['github-dark', 'github-light']);
    const themes = await Promise.all(Object.values(bundledThemes).map((load) => load()));

    expect(themes.map((theme) => theme.default.name ?? '').toSorted()).toEqual([
      'github-dark',
      'github-light',
    ]);
  });
});
