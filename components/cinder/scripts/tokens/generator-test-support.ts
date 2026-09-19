import type { CorpusEntry } from './corpus.ts';

export async function readCommitted(
  paths: Iterable<string>,
): Promise<Map<string, string | undefined>> {
  const existing = new Map<string, string | undefined>();
  for (const path of paths) {
    existing.set(
      path,
      await Bun.file(path)
        .text()
        .catch(() => undefined),
    );
  }
  return existing;
}

export function colorEntry(overrides: Partial<CorpusEntry> = {}): CorpusEntry {
  return {
    path: 'test.color',
    value: { colorSpace: 'oklch', components: [0.5, 0.1, 250] },
    type: 'color',
    description: undefined,
    cssProperty: '--test-color',
    cssRecipe: undefined,
    ...overrides,
  };
}
