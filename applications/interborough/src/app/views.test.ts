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
    // The agents area: its list is a table's width, an agent's page reads, and its memory and editor are wide.
    expect(widthOf('/agents')).toBe('full');
    expect(widthOf('/agents/:agent')).toBe('reading');
    expect(widthOf('/agents/:agent/memories')).toBe('full');
    expect(widthOf('/agents/:agent/memories/:memory')).toBe('full');
    expect(widthOf('/agents/new')).toBe('full');
    expect(widthOf('/agents/:agent/edit')).toBe('full');
    // The memory page and an agent's page share the `agents` view and differ in width.
    const memory = routes.find((route) => route.pattern === '/agents/:agent/memories');
    const openMemory = routes.find((route) => route.pattern === '/agents/:agent/memories/:memory');
    const detail = routes.find((route) => route.pattern === '/agents/:agent');
    expect(memory?.view).toBe(detail?.view);
    expect(openMemory?.view).toBe(detail?.view);
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
    expect(widthOf('/settings/model-policy')).toBe('full');
    expect(widthOf('/settings/plugins')).toBe('full');
    expect(widthOf('/settings/data-and-retention')).toBe('full');
    // The chat list sits beside the open chat, so every chat route is a list with its detail.
    for (const pattern of ['/chats', '/chats/new', '/chats/:chat']) {
      expect(widthOf(pattern), pattern).toBe('full');
    }
  });
});
