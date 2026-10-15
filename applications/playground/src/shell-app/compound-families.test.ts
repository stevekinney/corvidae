import { describe, expect, test } from 'bun:test';

import { CINDER_COMPONENT_SOURCE } from '../component-sources.ts';
import { COMPOSE_ONLY_COMPONENTS } from '../discover.ts';
import {
  COMPOUND_COMPONENT_FAMILIES,
  COMPOUND_COMPONENT_PARENTS,
  CONTEXT_REQUIRED_PARTS,
  LIST_ITEM_PARTS,
} from './compound-families.ts';

describe('compound-families registry completeness', () => {
  test('every compose-only leaf has a parent entry', () => {
    for (const leaf of COMPOSE_ONLY_COMPONENTS) {
      expect(COMPOUND_COMPONENT_PARENTS[leaf]).toBeDefined();
    }
  });

  test('every family root has a non-empty children list, and every child points back to it', () => {
    for (const [root, children] of Object.entries(COMPOUND_COMPONENT_FAMILIES)) {
      expect(children.length).toBeGreaterThan(0);
      for (const child of children) {
        expect(COMPOUND_COMPONENT_PARENTS[child]).toBe(root);
      }
    }
  });

  test('every parent entry appears in the matching family children list', () => {
    // The test above walks FAMILIES -> PARENTS; this walks the inverse direction,
    // PARENTS -> FAMILIES, so a stray or mistyped COMPOUND_COMPONENT_PARENTS entry
    // whose root has no matching FAMILIES entry (or whose child is missing from
    // that root's array) fails here even though it would pass the test above.
    for (const [child, root] of Object.entries(COMPOUND_COMPONENT_PARENTS)) {
      expect(COMPOUND_COMPONENT_FAMILIES[root]).toBeDefined();
      expect(COMPOUND_COMPONENT_FAMILIES[root]).toContain(child);
    }
  });
});

describe('CONTEXT_REQUIRED_PARTS', () => {
  test('is a subset of the compound-family leaves', () => {
    // The playground uses this to skip a bare mount. A slug that is not a known
    // compound leaf would be silently ignored (its page keeps the broken mount)
    // or, worse, would suppress a standalone component's preview outright.
    for (const part of CONTEXT_REQUIRED_PARTS) {
      expect(COMPOUND_COMPONENT_PARENTS[part]).toBeDefined();
    }
  });

  test('every listed part really does read a strict context getter at init scope', async () => {
    // Empirical drift guard. The set is hand-maintained because the strict/optional
    // distinction lives in the getter's DEFINITION, not at the call site — but a
    // listed part that no longer reads context at all should not keep losing its
    // live preview, and this catches that.
    //
    // The inverse direction (no UNLISTED leaf throws) is deliberately not asserted
    // here: proving it needs the getter definitions resolved across files, and the
    // honest version of that check is to bare-mount every leaf, which belongs in a
    // browser test rather than this data-integrity file.
    const { join } = await import('node:path');
    for (const part of CONTEXT_REQUIRED_PARTS) {
      const source = await Bun.file(
        join(CINDER_COMPONENT_SOURCE.componentsRoot, part, `${part}.svelte`),
      ).text();
      // Anchored on `Context(` so an unrelated `getBoundingClientRect(` cannot
      // satisfy the guard — the point is that the part still reads CONTEXT.
      // `\bget` excludes the optional `tryGet*Context(` accessors: those spell
      // it `Get`, and the lowercase `t` before it denies the word boundary.
      expect(/\bget[A-Za-z]*Context\s*\(/.test(source)).toBe(true);
    }
  });
});

describe('LIST_ITEM_PARTS', () => {
  test('lists exactly the compound leaves whose root element is a list item', async () => {
    // Both directions: a leaf whose markup starts with `<li` must skip the bare mount (an orphan
    // `<li>` fails axe `listitem`), and a listed part that no longer renders one should get its
    // live preview back. Leaves without a Cinder source (the `chat-*` package parts) are skipped,
    // and so are strict-context parts, which already skip the bare mount for that reason.
    const { join } = await import('node:path');
    const listItemRoots: string[] = [];
    for (const part of Object.keys(COMPOUND_COMPONENT_PARENTS)) {
      const file = Bun.file(join(CINDER_COMPONENT_SOURCE.componentsRoot, part, `${part}.svelte`));
      if (CONTEXT_REQUIRED_PARTS.has(part) || !(await file.exists())) continue;
      const source = await file.text();
      const markup = source
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/<style[\s\S]*?<\/style>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '');
      if (/<([a-z][a-z0-9-]*)\b/.exec(markup)?.[1] === 'li') listItemRoots.push(part);
    }

    expect(listItemRoots.toSorted()).toEqual([...LIST_ITEM_PARTS].toSorted());
  });
});
