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
});
