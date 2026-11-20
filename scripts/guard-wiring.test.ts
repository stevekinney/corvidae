import { describe, expect, test } from 'bun:test';

import { missingRequiredGuards } from './guard-wiring.ts';

const WIRED_SCRIPTS = {
  'lint:root': 'bun run lint:guards',
  'lint:guards': 'bun run knip && bun scripts/guard-wiring.ts',
  knip: 'bun scripts/run-knip.ts',
};

describe('root guard wiring', () => {
  test('accepts required guards reached through named root commands', () => {
    expect(missingRequiredGuards(WIRED_SCRIPTS)).toEqual([]);
  });

  test('reports a required guard disconnected from the executable lint graph', () => {
    const scripts = { ...WIRED_SCRIPTS, 'lint:guards': 'bun scripts/guard-wiring.ts' };
    expect(missingRequiredGuards(scripts)).toEqual(['scripts/run-knip.ts']);
  });
});
