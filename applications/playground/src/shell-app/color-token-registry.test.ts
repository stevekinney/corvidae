/*
 * Replaces the old curated color-token registry test (COR-263). The old registry listed a hand
 * maintained subset of the color tokens; the catalogue editor is generated from the runtime's
 * authoring catalogue instead, so this proves the complete surface: every public color record
 * has a reachable typed or recipe edit route, and the routes really edit.
 */
import { describe, expect, test } from 'bun:test';

import {
  AUTHORING_CATALOGUE,
  buildThemeSources,
  evaluateThemeProperties,
} from '@lostgradient/cinder/tokens/runtime';

import { cinderThemeBase } from './theme-builder-base.ts';
import { catalogueRows } from './theme-builder-catalogue.ts';
import { colorEditRoute, committedColor, type ColorEditRoute } from './theme-color-editing.ts';
import ColorTokenEditor from './theme-color-editor.svelte';
import { colorToJson, withChannel } from './theme-color-model.ts';
import type { ThemeEnvelope } from './theme-draft-types.ts';
import { applyEdit, createDraft } from './theme-draft.ts';
import { createEnvelope } from './theme-envelope.ts';
import { buildEdit, defaultScope, overrideScopeFor } from './theme-token-edit.ts';
import { editorForToken } from './theme-token-editors.ts';

const colorRows = catalogueRows.filter((row) => row.type === 'color');
const LIGHT = { colorMode: 'light', motion: 'default' } as const;

/** Edit every typed, alias, and recipe color through its own route in one draft, then evaluate. */
function editEveryColor() {
  const envelope: ThemeEnvelope = createEnvelope('t', 'T', cinderThemeBase());
  let draft = createDraft(envelope);
  const unreachable: string[] = [];
  for (const row of colorRows) {
    if (colorEditRoute(row) === 'css-only') continue;
    const scope = overrideScopeFor(defaultScope(row), LIGHT);
    const color = committedColor(row, envelope, LIGHT, scope);
    if (color === null) {
      unreachable.push(row.path);
      continue;
    }
    const first = Number(color.components[0]);
    const nudged = withChannel(color, 0, first >= 0.5 ? first - 0.001 : first + 0.001);
    const built = buildEdit(row, envelope, LIGHT, scope, JSON.stringify(colorToJson(nudged)));
    if (!built.ok) {
      unreachable.push(row.path);
      continue;
    }
    const result = applyEdit(draft, built.edit);
    if (!result.ok) unreachable.push(row.path);
    else draft = result.draft;
  }
  const evaluation = evaluateThemeProperties(buildThemeSources(draft.envelope, draft.revision));
  return { unreachable, evaluation };
}
const edited = editEveryColor();

describe('every public color record has an edit route', () => {
  test('the color records are derived from the authoring catalogue, never a hardcoded count', () => {
    const fromCatalogue = AUTHORING_CATALOGUE.records.filter(
      (record) => record.variants[0]?.provenance.effectiveType.type === 'color',
    );
    expect(colorRows.length).toBe(fromCatalogue.length);
    expect(colorRows.length).toBeGreaterThan(83);
    expect(new Set(colorRows.map((row) => row.path)).size).toBe(colorRows.length);
  });

  test('the color editor is registered for every color record', () => {
    for (const row of colorRows) expect(editorForToken(row)).toBe(ColorTokenEditor);
  });

  test('each record has exactly one route, and the routes partition the colors', () => {
    const routes = new Map<ColorEditRoute, string[]>();
    for (const row of colorRows) {
      const route = colorEditRoute(row);
      routes.set(route, [...(routes.get(route) ?? []), row.path]);
    }
    expect([...routes.keys()].toSorted()).toEqual([
      'alias-detach',
      'css-only',
      'recipe-replace',
      'typed-literal',
    ]);
    const total = [...routes.values()].reduce((sum, paths) => sum + paths.length, 0);
    expect(total).toBe(colorRows.length);
    expect(routes.get('recipe-replace')?.length).toBeGreaterThan(0);
    expect(routes.get('typed-literal')?.length).toBeGreaterThan(0);
    expect(routes.get('alias-detach')?.length).toBeGreaterThan(0);
  });

  test('a recipe color is edited by replacing the recipe with a literal, an alias by detaching', () => {
    const recipe = colorRows.find((row) => row.edit === 'recipe')!;
    const alias = colorRows.find((row) => row.edit === 'supported' && row.aliases.length > 0)!;
    expect(colorEditRoute(recipe)).toBe('recipe-replace');
    expect(colorEditRoute(alias)).toBe('alias-detach');
    expect(colorEditRoute(colorRows.find((row) => row.edit === 'css-only')!)).toBe('css-only');
  });

  test('every non-css-only color resolves to a literal and builds a valid edit', () => {
    expect(edited.unreachable).toEqual([]);
  });

  test('editing every color through its route leaves a theme the runtime accepts', () => {
    expect(edited.evaluation.ok ? [] : edited.evaluation.diagnostics.slice(0, 3)).toEqual([]);
  });
});
