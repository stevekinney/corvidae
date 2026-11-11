/**
 * Every route says what kind of page it is, which sets its width (COR-1834, design row 17f): a
 * page's width follows its kind, not its area, so the shell's outlet tells Cinder's reading column
 * and no page decides it for itself. There is one density everywhere (design row 02y), so a view
 * declares none.
 */
import { describe, expect, test } from 'bun:test';

import { routes } from './routes.ts';
import { PAGE_KINDS, pageWidth, VIEW_NAMES, VIEW_WIDTHS, VIEWS } from './views.ts';

/** The width the outlet gives the route with `pattern`. */
function widthOf(pattern: string): string {
  const route = routes.find((candidate) => candidate.pattern === pattern);
  if (route === undefined) throw new Error(`no route ${pattern}`);
  return pageWidth(route.kind);
}

describe('the views', () => {
  test('declare no density: one density everywhere', () => {
    for (const name of VIEW_NAMES) {
      expect(Object.keys(VIEWS[name]), name).not.toContain('density');
    }
  });
});

describe('page width by kind of page', () => {
  test('a list with its detail, a table, an editor and an overview are wide, and a form and prose read', () => {
    expect(PAGE_KINDS.map((kind) => [kind, pageWidth(kind)])).toEqual([
      ['list-detail', 'full'],
      ['table', 'full'],
      ['editor', 'full'],
      ['overview', 'full'],
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
    // The agents area: its list is a table's width, and so are an agent's page and its editor.
    expect(widthOf('/agents')).toBe('full');
    expect(widthOf('/agents/new')).toBe('full');
    expect(widthOf('/agents/:agent/edit')).toBe('full');
    // A run's setup is a form in the reading column, beside the wide run page of the same workflow.
    expect(widthOf('/workflows/:workflow/run')).toBe('reading');
    expect(widthOf('/workflows/:workflow/runs/:run')).toBe('full');
  });

  test('gives every tab of an agent’s page one width and view, so the header does not move between tabs', () => {
    const detail = routes.find((route) => route.pattern === '/agents/:agent');
    for (const tab of ['instructions', 'access', 'hooks', 'memory', 'settings']) {
      const pattern = `/agents/:agent/${tab}`;
      expect(widthOf(pattern), pattern).toBe('full');
      expect(routes.find((route) => route.pattern === pattern)?.view, pattern).toBe(detail?.view);
    }
    expect(widthOf('/agents/:agent')).toBe('full');
  });

  test('the operator tables stay wide and every settings section has the page to itself, its navigation beside one column', () => {
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
    expect(widthOf('/settings')).toBe('full');
    expect(widthOf('/settings/models')).toBe('full');
    expect(widthOf('/settings/allowed-models')).toBe('full');
    expect(widthOf('/settings/plugins')).toBe('full');
    expect(widthOf('/settings/data-and-retention')).toBe('full');
    // The chat list sits beside the open chat, so every chat route is a list with its detail.
    for (const pattern of ['/chats', '/chats/new', '/chats/:chat']) {
      expect(widthOf(pattern), pattern).toBe('full');
    }
  });
});
