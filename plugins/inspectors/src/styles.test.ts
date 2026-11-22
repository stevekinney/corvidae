import { describe, expect, it } from 'bun:test';

import {
  BASE_STYLES,
  PENDING_REVIEW_STYLES,
  RUN_TIMELINE_STYLES,
  SCHEDULE_EDITOR_STYLES,
  WORKFLOW_REVISION_STYLES,
} from './styles.ts';

// COR-2445 AC4 (COR-2314, COR-2303): a disabled control is muted by colour, as Cinder mutes it,
// never faded, so it stays legible. Cinder draws the control; these pages add layout only.
describe('inspector styles', () => {
  it.each([
    ['base', BASE_STYLES],
    ['pending review', PENDING_REVIEW_STYLES],
    ['workflow revision', WORKFLOW_REVISION_STYLES],
    ['run timeline', RUN_TIMELINE_STYLES],
    ['schedule editor', SCHEDULE_EDITOR_STYLES],
  ])('the %s styles fade no disabled control', (_name, styles) => {
    expect(styles).not.toMatch(/:disabled/);
    expect(styles).not.toMatch(/opacity\s*:\s*\.6/);
  });

  // A panel in a wide frame holds a readable column instead of spanning it, which stranded a badge
  // 1,750 pixels from the name it belongs to (COR-2542): the cap is the family's, set once.
  it('caps the page column in the base styles every panel inherits, and in no panel’s own', () => {
    expect(BASE_STYLES).toMatch(/\.panel-page\{[^}]*max-width:40rem/);
    for (const styles of [
      PENDING_REVIEW_STYLES,
      WORKFLOW_REVISION_STYLES,
      RUN_TIMELINE_STYLES,
      SCHEDULE_EDITOR_STYLES,
    ]) {
      expect(styles.split('.panel-page{').length - 1).toBe(1);
      expect(styles.split('max-width:40rem').length - 1).toBe(1);
    }
  });

  it('keeps the timeline’s notices out of its own styles: they are Cinder components', () => {
    expect(RUN_TIMELINE_STYLES).not.toContain('panel-notice');
  });
});
