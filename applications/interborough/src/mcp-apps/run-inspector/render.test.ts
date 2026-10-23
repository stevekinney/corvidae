import { describe, expect, it } from 'bun:test';

import { buildInspectorModel, type Inspection } from './model.ts';
import { describeChange, renderInspector } from './render.ts';

const inspection: Inspection = {
  schemaVersion: 'bureau.task-inspection.v1',
  taskId: 'run-<b>1</b>',
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
    evidence: [{ source: 'transport-keepalive', at: 1 }],
  },
  children: [],
};

describe('the run inspector page', () => {
  it('renders text as text, with a labelled landmark per section and a live region', () => {
    const root = document.createElement('div');
    renderInspector(root, buildInspectorModel(inspection, []), { onAbort: () => undefined }, null);
    expect(root.querySelector('b')).toBeNull();
    expect(root.querySelector('h1')?.textContent).toContain('<b>1</b>');
    expect(root.querySelector('main[aria-labelledby="inspector-title"]')).not.toBeNull();
    expect(root.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
    const headings = [...root.querySelectorAll('section')].map((node) =>
      node.getAttribute('aria-labelledby'),
    );
    expect(headings).toHaveLength(7);
    for (const id of headings) expect(root.querySelector(`#${id}`)?.tagName).toBe('H2');
  });

  it('labels transport heartbeat as not progress', () => {
    const root = document.createElement('div');
    renderInspector(root, buildInspectorModel(inspection, []), { onAbort: () => undefined }, null);
    const signals = root.querySelector('#inspector-signals')?.parentElement?.textContent ?? '';
    expect(signals).toContain('They are not progress');
    expect(root.querySelector('#inspector-progress')?.parentElement?.textContent).not.toContain(
      'transport-keepalive',
    );
  });

  it('enables abort only while the run can be aborted, and calls the handler once per click', () => {
    let aborts = 0;
    const root = document.createElement('div');
    renderInspector(
      root,
      buildInspectorModel(inspection, []),
      { onAbort: () => (aborts += 1) },
      null,
    );
    const button = root.querySelector('button')!;
    expect(button.disabled).toBe(false);
    button.click();
    expect(aborts).toBe(1);
    const ended = {
      ...inspection,
      task: { ...inspection.task, status: 'canceled', cleanup: 'cleaned-up' },
    };
    renderInspector(root, buildInspectorModel(ended, []), { onAbort: () => undefined }, null);
    expect(root.querySelector('button')!.disabled).toBe(true);
  });

  it('announces a lifecycle change and nothing for an identical model', () => {
    const before = buildInspectorModel(inspection, []);
    const after = buildInspectorModel(
      { ...inspection, task: { ...inspection.task, status: 'completed' } },
      [],
    );
    expect(describeChange(before, after)).toBe('Run is now completed.');
    expect(describeChange(before, before)).toBeNull();
    expect(describeChange(undefined, before)).toBeNull();
  });
});
