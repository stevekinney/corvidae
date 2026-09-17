import { expect, test } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const chunksDirectory = join(
  import.meta.dirname,
  '../.svelte-kit/output/client/_app/immutable/chunks',
);

async function grammarChunk(language: string): Promise<string> {
  const matches: string[] = [];
  for (const file of await readdir(chunksDirectory)) {
    if (!file.endsWith('.js')) continue;
    const source = await readFile(join(chunksDirectory, file), 'utf8');
    if (source.includes(`shiki-${language}.`)) {
      matches.push(file);
    }
  }
  expect(matches, `One emitted module must own the ${language} grammar`).toHaveLength(1);
  return `/_app/immutable/chunks/${matches[0]}`;
}

test('production grammar modules fetch intact frozen data and retain embedded grammars', async ({
  page,
}) => {
  await page.goto('/');
  for (const language of ['emacs-lisp', 'cpp-macro', 'svelte']) {
    const url = await grammarChunk(language);
    const responsePromise = page.waitForResponse((response) =>
      response.url().includes(`shiki-${language}.`),
    );
    const grammars = await page.evaluate(async (moduleUrl) => {
      const module = await import(moduleUrl);
      return Object.values(module)
        .flat()
        .filter((value) => typeof value === 'object' && value !== null && 'scopeName' in value)
        .map((value) => ({
          name: Reflect.get(value, 'name'),
          frozen: Object.isFrozen(value),
          patterns: Array.isArray(Reflect.get(value, 'patterns')),
        }));
    }, url);
    const response = await responsePromise;
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('application/json');
    expect(grammars).toContainEqual({ name: language, frozen: true, patterns: true });
    if (language === 'svelte') {
      expect(grammars.map((grammar) => grammar.name)).toEqual(
        expect.arrayContaining(['javascript', 'typescript', 'css', 'postcss']),
      );
    }
  }
});
