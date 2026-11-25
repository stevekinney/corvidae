import { describe, expect, test } from 'bun:test';

import { missingRequiredGuards } from './guard-wiring.ts';

const WIRED_SCRIPTS = {
  'lint:root':
    'bun scripts/check-installed-dependencies.ts && bun run lint:guards && bun run knip && bun scripts/guard-wiring.ts',
  'lint:guards': 'bun scripts/check-light-shadows.ts',
  knip: 'bun scripts/run-knip.ts',
};

describe('root guard wiring', () => {
  test('accepts required guards reached through named root commands', () => {
    expect(missingRequiredGuards(WIRED_SCRIPTS)).toEqual([]);
  });

  test('keeps the tracked root CI command wired', async () => {
    const manifest = (await Bun.file(new URL('../package.json', import.meta.url)).json()) as {
      scripts: Record<string, string>;
    };
    expect(missingRequiredGuards(manifest.scripts)).toEqual([]);
  });

  test('reports a required guard disconnected from the executable lint graph', () => {
    const scripts = {
      ...WIRED_SCRIPTS,
      'lint:root':
        'bun scripts/check-installed-dependencies.ts && bun run lint:guards && bun scripts/guard-wiring.ts',
    };
    expect(missingRequiredGuards(scripts)).toEqual(['scripts/run-knip.ts']);
  });

  test('reports the installed-dependency check when lint:root stops running it', () => {
    const scripts = {
      ...WIRED_SCRIPTS,
      'lint:root': 'bun run lint:guards && bun run knip && bun scripts/guard-wiring.ts',
    };
    expect(missingRequiredGuards(scripts)).toEqual(['scripts/check-installed-dependencies.ts']);
  });
});
