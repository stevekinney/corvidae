/// <reference lib="dom" />
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'bun:test';
import { tick } from 'svelte';

import { buildTimelineModel, type TimelineEntry } from './model.ts';
import Timeline from './timeline.svelte';
import { createTimelineView } from './view.svelte.ts';

const entries: TimelineEntry[] = [
  {
    step: 1,
    label: 'fetch <b>pages</b>',
    operationType: 'activity',
    status: 'completed',
    timestamp: 1_000,
    duration: 2_000,
    tries: 1,
  },
  {
    step: 2,
    label: 'summarize',
    operationType: 'activity',
    status: 'failed',
    timestamp: 3_000,
    duration: 1_000,
    tries: 3,
  },
  {
    step: 3,
    label: 'await-signal',
    operationType: 'await-signal',
    status: 'running',
    timestamp: 4_000,
    tries: 1,
  },
];

function open() {
  const view = createTimelineView();
  const rendered = render(Timeline, { props: { view } });
  return { view, ...rendered };
}

async function ready(
  view: ReturnType<typeof createTimelineView>,
  rows = entries,
  truncated = false,
) {
  view.model = buildTimelineModel(
    { runId: 'run-<i>1</i>', kind: 'workflow', entries: rows, truncated },
    9_000,
  );
  view.phase = 'ready';
  await tick();
}

describe('the run timeline page, drawn with Cinder (COR-2542)', () => {
  it('says it is loading until the first read answers', () => {
    const { container } = open();
    expect(container.querySelector('[data-state="loading"]')?.textContent).toContain('Loading');
    expect(container.querySelector('main')).toBeNull();
  });

  it('draws a row per step with its status, duration and tries, and renders text as text', async () => {
    const { view, container } = open();
    await ready(view);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('i')).toBeNull();
    expect(container.querySelector('h1')?.textContent).toContain('<i>1</i>');
    expect(container.querySelector('main[aria-labelledby="timeline-title"]')).not.toBeNull();
    const rows = [...container.querySelectorAll('li.timeline-step')];
    expect(rows.map((row) => row.getAttribute('data-step'))).toEqual(['1', '2', '3']);
    expect(rows[1]?.textContent).toContain('Failed');
    expect(rows[1]?.textContent).toContain('1 s');
    expect(rows[1]?.textContent).toContain('3 tries');
    expect(rows[2]?.textContent).toContain('Running');
    expect(rows[0]?.textContent).toContain('<b>pages</b>');
  });

  it('gives every bar a name a reader who cannot see it can read, and positions it on the scale', async () => {
    const { view, container } = open();
    await ready(view);
    const tracks = [...container.querySelectorAll('[role="img"]')];
    expect(tracks).toHaveLength(3);
    expect(tracks[0]?.getAttribute('aria-label')).toBe('Started 0 ms into the run, took 2 s');
    expect(tracks[2]?.getAttribute('aria-label')).toContain('still running');
    const bar = container.querySelector<HTMLElement>('.timeline-step__bar');
    expect(bar?.style.insetInlineStart).toBe('0%');
    expect(container.querySelector('.timeline-step__bar[data-open]')).not.toBeNull();
  });

  it('has a polite live region that survives a redraw, and no control or form', async () => {
    const { view, container } = open();
    await ready(view);
    view.announcement = 'Step 2, summarize, failed.';
    await tick();
    expect(container.querySelector('[role="status"][aria-live="polite"]')?.textContent).toContain(
      'Step 2, summarize, failed.',
    );
    expect(container.querySelector('form, button, input, a')).toBeNull();
  });

  it('says so when the run has no steps yet', async () => {
    const { view, container } = open();
    await ready(view, []);
    expect(container.querySelector('[data-state="empty"]')).not.toBeNull();
    expect(container.querySelector('ol')).toBeNull();
  });

  it('says so when the run has more steps than the read holds', async () => {
    const { view, container } = open();
    await ready(view, entries, true);
    expect(container.querySelector('[data-state="truncated"]')).not.toBeNull();
  });

  it('says when the run could not be read, and when the host will not let it read', async () => {
    const { view, container } = open();
    view.phase = 'unreadable';
    await tick();
    expect(container.querySelector('[data-state="unreadable"]')).not.toBeNull();
    view.phase = 'offline';
    await tick();
    expect(container.querySelector('[data-state="offline"]')).not.toBeNull();
  });

  it('keeps the timeline it has when a later read could not be read', async () => {
    const { view, container } = open();
    await ready(view);
    view.phase = 'unreadable';
    await tick();
    expect(container.querySelectorAll('li.timeline-step')).toHaveLength(3);
    expect(container.querySelector('[data-state="unreadable"]')).toBeNull();
  });
});
