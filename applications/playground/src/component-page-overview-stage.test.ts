import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
  describeOverviewStage,
  selectOverviewExample,
  type OverviewExampleDescriptor,
} from './component-page-overview-stage.ts';
import { discoverComponents, discoverExamples } from './discover.ts';
import { readExampleMetadata } from './example-metadata.ts';
import { stripExampleHarness } from './strip-example-harness.ts';

const EXAMPLES_ROOT = join(import.meta.dir, 'examples');

describe('selectOverviewExample', () => {
  const plain = { scenario: 'a', title: 'A' };
  const featured = { scenario: 'b', title: 'B', featured: true };

  test('prefers the first explicitly featured example', () => {
    expect(selectOverviewExample([plain, featured], false)).toBe(featured);
  });

  test('falls back to the first example', () => {
    expect(selectOverviewExample([plain, { scenario: 'c', title: 'C' }], false)).toBe(plain);
  });

  test('selects nothing without examples', () => {
    expect(selectOverviewExample([], false)).toBeUndefined();
  });

  test('selects nothing in snapshot mode', () => {
    expect(selectOverviewExample([plain, featured], true)).toBeUndefined();
  });
});

describe('describeOverviewStage', () => {
  test('derives the stage title, mount, and source item from one descriptor', () => {
    const stage = describeOverviewStage({
      scenario: 'disabled',
      title: 'Disabled combobox',
      description: 'Cannot be edited.',
    });
    expect(stage).toEqual({
      scenario: 'disabled',
      title: 'Disabled combobox',
      description: 'Cannot be edited.',
      mountId: 'overview-mount-disabled',
      sourceItemId: 'overview-source-disabled',
    });
  });
});

describe('every generated example catalogue entry', () => {
  test('resolves stage scenario, title, mount, and code item from one selected descriptor', async () => {
    const components = await discoverComponents();
    let checked = 0;
    for (const componentName of components) {
      const scenarios = await discoverExamples(componentName);
      const examples: OverviewExampleDescriptor[] = await Promise.all(
        scenarios.map(async (scenario) => ({
          scenario,
          ...(await readExampleMetadata(
            join(EXAMPLES_ROOT, componentName, `${scenario}.example.svelte`),
          )),
        })),
      );
      const selected = selectOverviewExample(examples, false);
      if (examples.length === 0) {
        expect(selected).toBeUndefined();
        continue;
      }
      expect(selected, componentName).toBeDefined();
      if (selected === undefined) continue;
      expect(examples, componentName).toContain(selected);
      const stage = describeOverviewStage(selected);
      expect(stage.scenario, componentName).toBe(selected.scenario);
      expect(stage.title, componentName).toBe(selected.title);
      expect(stage.mountId, componentName).toBe(`overview-mount-${selected.scenario}`);
      expect(stage.sourceItemId, componentName).toBe(`overview-source-${selected.scenario}`);
      expect(stage.title, componentName).not.toBe('');
      checked += 1;
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe('Overview stage matches the README usage it sits beside', () => {
  const README_ROOT = join(
    import.meta.dir,
    '..',
    '..',
    '..',
    'components',
    'cinder',
    'src',
    'components',
  );

  /** The component call (everything after the last `</script>`) of a Svelte snippet. */
  function markupOf(source: string): string {
    return source
      .slice(source.lastIndexOf('</script>') + '</script>'.length)
      .replace(/\s+/g, ' ')
      .trim();
  }

  for (const componentName of ['combobox', 'message']) {
    test(`${componentName}: the featured example's displayed code contains the README usage markup`, async () => {
      const readme = await Bun.file(join(README_ROOT, componentName, 'README.md')).text();
      const usage = readme.match(/```svelte\n([\s\S]*?)```/)?.[1];
      expect(usage).toBeDefined();

      const scenarios = await discoverExamples(componentName);
      const examples: OverviewExampleDescriptor[] = await Promise.all(
        scenarios.map(async (scenario) => ({
          scenario,
          ...(await readExampleMetadata(
            join(EXAMPLES_ROOT, componentName, `${scenario}.example.svelte`),
          )),
        })),
      );
      const selected = selectOverviewExample(examples, false);
      expect(selected).toBeDefined();
      const exampleSource = await Bun.file(
        join(EXAMPLES_ROOT, componentName, `${selected?.scenario}.example.svelte`),
      ).text();
      const displayed = stripExampleHarness(
        exampleSource,
        `${componentName}/${selected?.scenario}`,
      );

      expect(markupOf(displayed)).toBe(markupOf(usage ?? ''));
    });
  }
});
