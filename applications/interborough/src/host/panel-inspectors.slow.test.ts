/**
 * The six inspectors panels, built by the host's own panel build (COR-2218): each is a Svelte
 * component that renders Cinder through `@lostgradient/cinder/panel`, so each must build into one
 * self-contained document that carries the kit's host-theme tokens and loads nothing from beside
 * itself. A build takes seconds, so this is a slow-lane test; the Playwright specs in
 * `tests/panels` load the same pages in a frame.
 */
import {
  failureExplanation,
  pendingReview,
  runComparison,
  runInspector,
  runTimeline,
  scheduleEditor,
  workflowRevisionReview,
} from '@lostgradient/plugin-inspectors';
import { describe, expect, test } from 'bun:test';

import { buildPanelPage } from './panel-build.ts';

describe.each([
  ['the run inspector', runInspector],
  ['the pending-review list', pendingReview],
  ['the workflow revision review', workflowRevisionReview],
  ['the schedule editor', scheduleEditor],
  ['the failure explanation', failureExplanation],
  ['the run timeline', runTimeline],
  ['the run comparison', runComparison],
])('%s', (_name, panel) => {
  test('builds into one self-contained page whose styles follow the host theme', async () => {
    const { html, contentDigest } = await buildPanelPage({
      entry: panel.entry.href,
      title: panel.title,
      styles: panel.styles ?? '',
    });
    expect(contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html.match(/<script/g)).toHaveLength(1);
    // The kit's rule reads the host's variable and falls back to Cinder's own value.
    expect(html).toMatch(/--cinder-surface-canvas:var\(--color-background-primary/);
    expect(html).toContain('--cinder-status-info-background');
    // Nothing the page loads comes from beside it.
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/<script[^>]*\ssrc=/);
    // In the stylesheet only: the script holds libraries with a `url(` method of their own.
    const styles = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    expect(styles).not.toMatch(/@import/);
    expect(styles).not.toMatch(/url\(\s*['"]?(?!data:)[^)'"\s]/);
    // The page's own layout, which is Cinder tokens and no color of its own.
    expect(html).toContain('.panel-page');
    expect(panel.styles ?? '').not.toMatch(
      /#[0-9a-f]{3,8}\b|rgb\(|hsl\(|oklch\(|Canvas|ButtonFace/i,
    );
  });
});
