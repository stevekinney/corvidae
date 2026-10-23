/**
 * Every view declares how dense and how wide it is (COR-1647), so the shell's outlet can say so
 * to Cinder's density tokens and its reading column, and no page decides either for itself.
 */
import { describe, expect, test } from 'bun:test';

import { VIEW_DENSITIES, VIEW_NAMES, VIEW_WIDTHS, VIEWS } from './views.ts';

describe('the views', () => {
  test('each declares a density and a width the shell knows', () => {
    for (const name of VIEW_NAMES) {
      expect(VIEW_DENSITIES, `${name} density`).toContain(VIEWS[name].density);
      expect(VIEW_WIDTHS, `${name} width`).toContain(VIEWS[name].width);
    }
  });

  test('the operator tables are compact and full width, and the pages a person reads are not', () => {
    for (const name of ['runs', 'audit', 'engine', 'workers', 'storage', 'system'] as const) {
      expect(VIEWS[name], name).toMatchObject({ density: 'compact', width: 'full' });
    }
    for (const name of [
      'chat',
      'agents',
      'agent-editor',
      'workflows',
      'schedules',
      'reviews',
    ] as const) {
      expect(VIEWS[name], name).toMatchObject({ density: 'comfortable', width: 'reading' });
    }
  });
});
