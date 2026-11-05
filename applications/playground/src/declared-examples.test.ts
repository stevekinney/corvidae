/**
 * A component's `*.examples.json` declares the examples its documentation publishes, and the
 * playground renders one `*.example.svelte` per id so each has a capture to review. A declared
 * example with no playground file is invisible to the design review, which can only judge what is
 * captured, so every component listed here must carry a playground file for every declared id.
 *
 * The list grows as components are brought in line; the components outside it still have gaps.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CINDER_COMPONENT_SOURCE } from './component-sources.ts';

const COMPONENTS_WITH_EVERY_DECLARED_EXAMPLE = [
  'approval-card',
  'meter',
  'payload-inspector',
  'text',
  'tool-call-panel',
  'tool-call-rail',
] as const;

const EXAMPLES_ROOT = join(import.meta.dirname, 'examples');

describe('declared examples', () => {
  for (const component of COMPONENTS_WITH_EVERY_DECLARED_EXAMPLE) {
    it(`${component} has a playground example for every id its examples.json declares`, () => {
      const artifact = JSON.parse(
        readFileSync(
          join(CINDER_COMPONENT_SOURCE.componentsRoot, component, `${component}.examples.json`),
          'utf8',
        ),
      ) as { examples: { id: string }[] };

      const missing = artifact.examples
        .map((example) => example.id)
        .filter((id) => !existsSync(join(EXAMPLES_ROOT, component, `${id}.example.svelte`)));

      expect(missing).toEqual([]);
    });
  }
});
