/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { flushSync, mount, tick, unmount } from 'svelte';

import { AUTHORING_CATALOGUE, TOKEN_TYPES } from '@lostgradient/cinder/tokens/runtime';
import { setupHappyDom } from '@lostgradient/testing';

import { catalogueRows, type CatalogueRow } from './theme-builder-catalogue.ts';
import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import type { JsonObject } from './theme-draft-types.ts';
import { editableState } from './theme-draft-types.ts';
import { fixtureEnvelope } from './theme-reference-fixtures.ts';
import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';
import { sourceTokenRow } from './theme-source-token-row.ts';
import { validateCssForRow } from './theme-token-edit.ts';
import GenericTokenEditor from './theme-token-editor-generic.svelte';
import { editorForToken, hasTypedEditor } from './theme-token-editors.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

setupHappyDom();

/**
 * How each public token can be edited, joined from the authoring catalogue's disposition and
 * the editor registry. A token with no entry here has no editing path, and the gate fails.
 */
type EditingPath = 'typed-editor' | 'recipe-inputs-or-css-override' | 'css-override';

function editingPathsOf(row: CatalogueRow): EditingPath[] {
  const paths: EditingPath[] = [];
  switch (row.edit) {
    case 'supported':
      if (hasTypedEditor(row.type) && editorForToken(row) !== GenericTokenEditor) {
        paths.push('typed-editor');
      }
      break;
    case 'recipe': {
      const inputsEditable =
        row.recipeInputs.length > 0 &&
        row.recipeInputs.every((input) => catalogueRows.some((other) => other.path === input));
      const cssWorks =
        row.profile !== undefined &&
        validateCssForRow(row, 'oklch(55% 0.2 270)', null).ok === (row.type === 'color');
      if (inputsEditable || cssWorks) paths.push('recipe-inputs-or-css-override');
      break;
    }
    case 'css-only':
      if (
        row.shippedCssValue !== undefined &&
        validateCssForRow(row, row.shippedCssValue, null).ok
      ) {
        paths.push('css-override');
      }
      break;
  }
  return paths;
}

describe('the coverage gate', () => {
  test('every public token has at least one editing path', () => {
    expect(catalogueRows.length).toBe(AUTHORING_CATALOGUE.records.length);
    expect(catalogueRows.length).toBeGreaterThan(0);
    const without = catalogueRows
      .filter((row) => editingPathsOf(row).length === 0)
      .map((row) => `${row.path} (${row.type}, ${row.edit})`);
    expect(without).toEqual([]);
  });

  test('every disposition the catalogue declares has an editor path', () => {
    const dispositions = new Set(
      AUTHORING_CATALOGUE.records.map((record) => record.disposition.edit),
    );
    expect([...dispositions].toSorted()).toEqual(['css-only', 'recipe', 'supported']);
  });

  test('every shipped CSS-only value passes the CSS-only grammar it is edited with', () => {
    const cssOnly = catalogueRows.filter((row) => row.edit === 'css-only');
    expect(cssOnly.length).toBeGreaterThan(0);
    for (const row of cssOnly) {
      expect(validateCssForRow(row, row.shippedCssValue!, null)).toMatchObject({ ok: true });
    }
  });

  test('every effective type in the catalogue has a typed editor', () => {
    const types = new Set(catalogueRows.map((row) => row.type));
    for (const type of types) expect(hasTypedEditor(type)).toBe(true);
  });

  test('all 13 DTCG types have a typed editor, so a Source token of any type is editable', () => {
    expect(TOKEN_TYPES).toHaveLength(13);
    for (const type of TOKEN_TYPES) {
      expect(hasTypedEditor(type)).toBe(true);
      expect(editorForToken(sourceTokenRow(`coverage.${type}`, type))).not.toBe(GenericTokenEditor);
    }
  });

  test('an unknown type falls back to the generic editor rather than to nothing', () => {
    expect(editorForToken(sourceTokenRow('coverage.unknown', 'unknown'))).toBe(GenericTokenEditor);
  });
});

// --- every type renders an editor for a Source token ----------------------------------------

const px = (value: number) => ({ value, unit: 'px' });
const SCALAR_SOURCES: JsonObject = {
  color: { $type: 'color', $value: { colorSpace: 'srgb', components: [0.2, 0.4, 0.8] } },
  dimension: { $type: 'dimension', $value: px(8) },
  fontFamily: { $type: 'fontFamily', $value: ['Inter', 'sans-serif'] },
  fontWeight: { $type: 'fontWeight', $value: 600 },
  duration: { $type: 'duration', $value: { value: 150, unit: 'ms' } },
  cubicBezier: { $type: 'cubicBezier', $value: [0.4, 0, 0.2, 1] },
  number: { $type: 'number', $value: 2 },
};

const evaluator = createRuntimeEvaluator();
let mounted: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

beforeEach(() => {
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(() => {
  if (mounted !== null) void unmount(mounted);
  mounted = null;
  target.remove();
});

describe('every DTCG type is editable on a Source token', () => {
  const fixture = fixtureEnvelope();
  const envelope = {
    ...fixture,
    overrides: {
      ...fixture.overrides,
      shared: { ...fixture.overrides.shared, coverage: SCALAR_SOURCES },
    },
  };
  const paths: Record<string, string> = {
    shadow: 'fx.shadow',
    gradient: 'fx.gradient',
    border: 'fx.border',
    transition: 'fx.transition',
    strokeStyle: 'fx.stroke',
    typography: 'fx.typography',
  };

  test.each(TOKEN_TYPES.map((type) => [type] as const))('%s', async (type) => {
    const workbench = new ThemeWorkbenchState();
    const controller = new ThemeBuilderController({ workbench, evaluator, persistence: null });
    await controller.start();
    const seeded = await controller.commit({
      kind: 'edit',
      label: 'Seed',
      state: editableState(envelope),
    });
    expect(seeded.ok).toBe(true);
    const row = { ...sourceTokenRow(paths[type] ?? `coverage.${type}`, type), themeAware: true };
    const Editor = editorForToken(row);
    mounted = mount(Editor, { target, props: { controller, workbench, row } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    await tick();
    const controls = target.querySelectorAll('input, select, button');
    expect(controls.length).toBeGreaterThan(1);
    const apply = [...target.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Apply',
    );
    expect(apply).toBeDefined();
  });
});
