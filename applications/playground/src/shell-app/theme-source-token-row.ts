/**
 * A catalogue row for a Source token (COR-488): a token that lives only in the theme's source
 * documents, so it has no CSS property, no usage profile and no recipe. The editors treat it
 * like any public token of the same type, and the disclosure says "Source only" for it. The
 * shipped corpus has no public strokeStyle, border, transition, gradient or typography
 * token, so the editors for those types are exercised through rows like this one.
 */

import type { CatalogueRow } from './theme-builder-catalogue.ts';

export function sourceTokenRow(path: string, type: string): CatalogueRow {
  const words = path.replaceAll('.', ' ').replaceAll('-', ' ');
  return {
    path,
    name: words.charAt(0).toUpperCase() + words.slice(1),
    cssProperty: '',
    type,
    context: 'all contexts',
    group: 'source',
    description: '',
    component: null,
    themeAware: false,
    edit: 'supported',
    shippedCssValue: undefined,
    aliases: [],
    recipeInputs: [],
    profile: undefined,
  };
}

/** True for a row that has no CSS binding, so nothing invents a property for it. */
export const isSourceOnly = (row: Pick<CatalogueRow, 'cssProperty'>): boolean =>
  row.cssProperty === '';
