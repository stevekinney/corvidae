import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { parse, type Root } from 'postcss';

/**
 * The popover's base rules used to load from a separate aggregator imported right after
 * `feed/feed.css`; they now sit at the top of `popover/popover.css`, which loads later. Moving a
 * rule later reorders it against every stylesheet imported in between, so none of those may
 * carry a rule for `cinder-popover`: a competing rule there would now lose to the relocated block.
 */
const componentsStylesheet = join(import.meta.dir, 'components.css');
const IMPORT = /@import\s+(?:url\(\s*)?["']?([^"')\s]+\.css)["']?/g;

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(IMPORT)].map((match) => resolve(dirname(file), match[1]!));
}

/** Every stylesheet a file pulls in through nested `@import`s, excluding the file itself. */
function nestedImportsOf(file: string, seen = new Set<string>()): string[] {
  for (const child of importsOf(file)) {
    if (seen.has(child)) continue;
    seen.add(child);
    nestedImportsOf(child, seen);
  }
  return [...seen];
}

function declaredProperties(root: Root, keep: (selector: string) => boolean): Set<string> {
  const properties = new Set<string>();
  root.walkRules((rule) => {
    if (!keep(rule.selector)) return;
    rule.walkDecls((declaration) => {
      properties.add(declaration.prop);
    });
  });
  return properties;
}

describe('popover stylesheet relocation', () => {
  const entries = importsOf(componentsStylesheet);
  const popover = resolve(import.meta.dir, '../components/popover/popover.css');
  const previousNeighbour = resolve(import.meta.dir, '../components/feed/feed.css');

  test('the popover stylesheet and its old neighbour are both imported, in that order', () => {
    expect(entries).toContain(popover);
    expect(entries).toContain(previousNeighbour);
    expect(entries.indexOf(previousNeighbour)).toBeLessThan(entries.indexOf(popover));
  });

  const between = entries.slice(entries.indexOf(previousNeighbour) + 1, entries.indexOf(popover));

  test('no stylesheet imported between the old and the new position mentions the popover', () => {
    expect(between.length).toBeGreaterThan(0);
    const offenders = between.filter((file) =>
      readFileSync(file, 'utf8').includes('cinder-popover'),
    );
    expect(offenders).toEqual([]);
  });

  test('a stylesheet an in-between import re-includes declares no property the relocated block sets', () => {
    // `invocation-rule-builder.css` re-includes `combobox.css` between the two positions, and
    // that file styles `.cinder-combobox__panel.cinder-popover` (two classes). The re-included
    // copy used to follow the block and now precedes it. Order only decides a tie, so only the
    // block's attribute-qualified rules (`[popover]` and the fallback placements, two classes
    // worth of specificity) can be affected; its bare `.cinder-popover` rule loses to a
    // two-class selector whatever the order.
    const relocatedSelector = (selector: string): boolean =>
      /^\.cinder-popover(\[popover\]|\[data-cinder-placement='[a-z-]+'\])$/.test(selector);
    const relocated = declaredProperties(parse(readFileSync(popover, 'utf8')), relocatedSelector);
    expect(relocated.size).toBeGreaterThan(0);

    const reIncluded = [...new Set(between.flatMap((file) => nestedImportsOf(file)))].filter(
      (file) => readFileSync(file, 'utf8').includes('cinder-popover'),
    );
    expect(reIncluded.length).toBeGreaterThan(0);
    for (const file of reIncluded) {
      const competing = declaredProperties(parse(readFileSync(file, 'utf8')), (selector) =>
        selector.includes('cinder-popover'),
      );
      expect([file, [...competing].filter((property) => relocated.has(property))]).toEqual([
        file,
        [],
      ]);
    }
  });

  test('the popover stylesheet is a single cinder.components block', () => {
    const source = readFileSync(popover, 'utf8');
    expect(source.match(/^@layer cinder\.components \{/gm)).toHaveLength(1);
  });
});
