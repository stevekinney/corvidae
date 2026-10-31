/**
 * Every view declares how dense it is (COR-1647), and every route says what kind of page it is,
 * which sets its width (COR-1834, design row 17f): a page's width follows its kind, not its area,
 * so the shell's outlet tells Cinder's density tokens and its reading column, and no page decides
 * either for itself.
 */
import { describe, expect, test } from 'bun:test';

import { routes } from './routes.ts';
import { PAGE_KINDS, pageWidth, VIEW_DENSITIES, VIEW_NAMES, VIEW_WIDTHS, VIEWS } from './views.ts';

/** The width the outlet gives the route with `pattern`. */
function widthOf(pattern: string): string {
  const route = routes.find((candidate) => candidate.pattern === pattern);
  if (route === undefined) throw new Error(`no route ${pattern}`);
  return pageWidth(route.kind);
}

describe('the views', () => {
  test('each declares a density the shell knows', () => {
    for (const name of VIEW_NAMES) {
      expect(VIEW_DENSITIES, `${name} density`).toContain(VIEWS[name].density);
    }
  });

  test('the operator tables are compact, and the pages a person reads are not', () => {
    for (const name of ['runs', 'audit', 'health', 'workers', 'storage'] as const) {
      expect(VIEWS[name].density, name).toBe('compact');
    }
    for (const name of [
      'chat',
      'agents',
      'agent-editor',
      'workflows',
      'schedules',
      'reviews',
    ] as const) {
      expect(VIEWS[name].density, name).toBe('comfortable');
    }
  });
});

describe('page width by kind of page', () => {
  test('a list with its detail, a table and an editor are wide, and a form and prose read', () => {
    expect(PAGE_KINDS.map((kind) => [kind, pageWidth(kind)])).toEqual([
      ['list-detail', 'full'],
      ['table', 'full'],
      ['editor', 'full'],
      ['form', 'reading'],
      ['reading', 'reading'],
    ]);
  });

  test('every route says its kind, and its width is that kind’s', () => {
    for (const route of routes) {
      expect(PAGE_KINDS, route.pattern).toContain(route.kind);
      expect(VIEW_WIDTHS, route.pattern).toContain(pageWidth(route.kind));
    }
  });

  test('one area holds pages of more than one width, so the width is not the area’s', () => {
    // The agents area: its list and an agent's page read, and its memory and editor are wide.
    expect(widthOf('/agents')).toBe('reading');
    expect(widthOf('/agents/:agent')).toBe('reading');
    expect(widthOf('/agents/:agent/memories')).toBe('full');
    expect(widthOf('/agents/new')).toBe('full');
    expect(widthOf('/agents/:agent/edit')).toBe('full');
    // The memory page and an agent's page share the `agents` view and differ in width.
    const memory = routes.find((route) => route.pattern === '/agents/:agent/memories');
    const detail = routes.find((route) => route.pattern === '/agents/:agent');
    expect(memory?.view).toBe(detail?.view);
  });

  test('the operator tables stay wide and the settings form keeps the reading width', () => {
    for (const pattern of [
      '/capabilities',
      '/runs',
      '/runs/:run',
      '/workflows/:workflow/runs/:run',
      '/health',
      '/health/workers',
      '/health/storage',
      '/settings/api-reference',
      '/health/audit',
    ]) {
      expect(widthOf(pattern), pattern).toBe('full');
    }
    expect(widthOf('/settings')).toBe('reading');
    expect(widthOf('/settings/data-and-retention')).toBe('reading');
    expect(widthOf('/chats/:chat')).toBe('reading');
  });
});
