/**
 * Where the "Back to …" button of the not-found page leads: the list the missing thing belonged
 * to, named as the sidebar names it.
 */
import { describe, expect, test } from 'bun:test';

import { DESTINATIONS } from './shell/destinations.ts';
import { viewParent } from './view-parent.ts';
import { VIEW_NAMES } from './views.ts';

describe('viewParent', () => {
  test('a view the sidebar opens leads back to its own destination', () => {
    expect(viewParent('runs')).toEqual({ label: 'Runs', path: '/runs' });
    expect(viewParent('schedules')).toEqual({ label: 'Schedules', path: '/schedules' });
    expect(viewParent('home')).toEqual({ label: 'Home', path: '/' });
  });

  test('the agent editor leads back to Agents, and the pages under Health to themselves', () => {
    expect(viewParent('agent-editor')).toEqual({ label: 'Agents', path: '/agents' });
    expect(viewParent('audit')).toEqual({ label: 'Audit log', path: '/health/audit' });
    expect(viewParent('workers').path).toBe('/health/workers');
    expect(viewParent('storage').path).toBe('/health/storage');
  });

  test('every view has a parent page, and a destination is its own parent', () => {
    for (const view of VIEW_NAMES) {
      expect(viewParent(view).path.startsWith('/')).toBe(true);
    }
    for (const destination of DESTINATIONS) {
      expect(viewParent(destination.view).path).toBe(destination.path);
    }
  });
});
