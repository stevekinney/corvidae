/// <reference lib="dom" />
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'bun:test';
import { tick } from 'svelte';

import Inspector from './inspector.svelte';
import { buildInspectorModel, type Inspection, WORKFLOW_RUN_NOTICE } from './model.ts';
import { createInspectorView } from './view.svelte.ts';

const inspection: Inspection = {
  schemaVersion: 'bureau.task-inspection.v1',
  taskId: 'run-<b>1</b>',
  canCancel: true,
  task: {
    id: 'run-1',
    agentName: 'worker',
    owner: 'o',
    status: 'working',
    finishReason: null,
    statusMessage: null,
    createdAt: 'a',
    updatedAt: 'b',
    cleanup: null,
    openWaits: [],
  },
  liveness: {
    status: 'running',
    assessment: 'healthy',
    reachability: 'reachable',
    progress: 'progressing',
    revision: 1,
    cancellable: true,
    evidence: [
      { source: 'transport-keepalive', at: 1 },
      { source: 'tool-progress', at: 2 },
    ],
  },
  children: [],
};

function open(onAbort: () => void = () => undefined) {
  const view = createInspectorView();
  view.model = buildInspectorModel(inspection, []);
  const rendered = render(Inspector, { props: { view, onAbort } });
  return { view, ...rendered };
}

describe('the run inspector page, drawn with Cinder (COR-2218)', () => {
  it('renders text as text, with a labelled landmark per section and a live region', () => {
    const { container } = open();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('h1')?.textContent).toContain('<b>1</b>');
    expect(container.querySelector('main[aria-labelledby="inspector-title"]')).not.toBeNull();
    expect(container.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
    const sections = [...container.querySelectorAll('section')];
    expect(sections.map((node) => node.querySelector('h2')?.textContent)).toEqual([
      'Lifecycle',
      'Ownership tree',
      'Progress evidence',
      'Liveness signals',
      'Result',
      'Event stream',
      'Abort and cleanup',
    ]);
    for (const node of sections) {
      const heading = container.querySelector(`#${node.getAttribute('aria-labelledby')}`);
      expect(heading?.tagName).toBe('H2');
    }
  });

  it('is built from Cinder components, so it takes the host theme through the kit', () => {
    const { container } = open();
    expect(container.querySelectorAll('.cinder-section')).toHaveLength(7);
    expect(container.querySelector('.cinder-description-list')).not.toBeNull();
    expect(container.querySelector('button.cinder-button')).not.toBeNull();
  });

  it('labels transport heartbeat as not progress', () => {
    const { container } = open();
    const [, , progress, signals] = [...container.querySelectorAll('section')];
    expect(signals?.textContent).toContain('They are not progress');
    expect(signals?.textContent).toContain('transport-keepalive');
    expect(progress?.textContent).not.toContain('transport-keepalive');
    expect(progress?.textContent).toContain('tool-progress');
  });

  it('enables abort only while the run can be aborted, and calls the handler once per click', async () => {
    let aborts = 0;
    const { view, getByRole } = open(() => (aborts += 1));
    const button = getByRole('button', { name: 'Abort run' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    button.click();
    expect(aborts).toBe(1);
    view.model = buildInspectorModel(
      { ...inspection, task: { ...inspection.task, status: 'canceled', cleanup: 'cleaned-up' } },
      [],
    );
    await tick();
    expect((getByRole('button', { name: 'Abort run' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('updates in place: a poll keeps the focused control and the live region element', async () => {
    const { view, getByRole, container } = open();
    const button = getByRole('button', { name: 'Abort run' });
    button.focus();
    const status = container.querySelector('#inspector-status');
    view.announcement = 'Run is now working.';
    view.model = buildInspectorModel(
      {
        ...inspection,
        liveness: { ...inspection.liveness!, revision: 2, assessment: 'slow' },
      },
      [],
    );
    await tick();
    expect(container.querySelector('#inspector-status')).toBe(status);
    expect(status?.textContent?.trim()).toBe('Run is now working.');
    expect(container.querySelector('section')?.textContent).toContain('slow');
    expect(document.activeElement).toBe(getByRole('button', { name: 'Abort run' }));
    expect(document.activeElement).toBe(button);
  });

  it('shows a gap in the stream and a removed task in words', async () => {
    const { view, container } = open();
    view.model = buildInspectorModel(inspection, [
      { kind: 'task.gap', requestedCursor: 'c1', firstRetainedCursor: 'c9' },
    ]);
    await tick();
    expect(container.textContent).toContain(
      'Gap: events from c1 are no longer retained; the stream resumes at c9.',
    );
  });

  it('says in its own words that a workflow run has no task to inspect, and offers no abort', async () => {
    const view = createInspectorView();
    const { container, queryByRole } = render(Inspector, {
      props: { view, onAbort: () => undefined },
    });
    view.notice = WORKFLOW_RUN_NOTICE;
    await tick();
    expect(container.querySelector('[data-inspector-notice]')?.textContent).toBe(
      WORKFLOW_RUN_NOTICE,
    );
    expect(container.querySelector('h1')?.textContent).toBe('Run inspector');
    expect(queryByRole('button', { name: 'Abort run' })).toBeNull();
  });

  it('draws nothing but the live region before the first read', () => {
    const view = createInspectorView();
    const { container } = render(Inspector, { props: { view, onAbort: () => undefined } });
    expect(container.querySelector('main')).toBeNull();
    expect(container.querySelector('#inspector-status')).not.toBeNull();
  });
});
