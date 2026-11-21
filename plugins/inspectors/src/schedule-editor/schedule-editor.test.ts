/// <reference lib="dom" />
import {
  scheduleDraftOf,
  type ScheduleDraft,
} from '@lostgradient/interborough-plugin/schedule-form';
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it } from 'bun:test';
import { tick } from 'svelte';

import type { ScheduleView } from './model.ts';
import ScheduleEditor from './schedule-editor.svelte';
import { createEditorView, type EditorView } from './view.svelte.ts';

const schedule: ScheduleView = {
  id: 's<1>',
  revision: 2,
  status: 'active',
  description: '<b>Morning</b>',
  cronExpression: '0 9 * * *',
  intervalMs: null,
  timeZone: 'UTC',
  nextFireAt: null,
  target: { kind: 'agent', agentName: 'writer' },
};

function open(change: (view: EditorView) => void = () => undefined) {
  const calls: string[] = [];
  const view = createEditorView();
  view.phase = 'ready';
  view.agents = [
    { value: 'writer', label: 'Writer' },
    { value: 'editor', label: 'Editor' },
  ];
  view.workflows = [{ value: 'kit:echo', label: 'Echo' }];
  change(view);
  const handlers = {
    onOpen: (id: string) => calls.push(`open:${id}`),
    onNew: () => calls.push('new'),
    onBack: () => calls.push('back'),
    onSave: () => calls.push('save'),
    onReload: () => calls.push('reload'),
    onEdit: (edit: Partial<ScheduleDraft>) => calls.push(`edit:${JSON.stringify(edit)}`),
  };
  return { view, calls, ...render(ScheduleEditor, { props: { view, handlers } }) };
}

/** Opens the form on `source`, or on a new schedule when `source` is `null`. */
function showForm(view: EditorView, source: ScheduleView | null = schedule): void {
  view.screen = 'form';
  view.source = source ?? undefined;
  if (source !== null) view.draft = scheduleDraftOf(source);
}

describe('the schedule editor, drawn with Cinder (COR-2545)', () => {
  it('says it is loading, and says when the schedules cannot be read', () => {
    const loading = open((view) => {
      view.phase = 'loading';
    });
    expect(loading.container.textContent).toContain('Loading schedules');
    loading.unmount();
    const failed = open((view) => {
      view.phase = 'failed';
    });
    expect(failed.container.textContent).toContain('The schedules could not be read.');
  });

  it('lists the schedules as text, opens one, and starts a new one', async () => {
    const { container, calls, getByRole } = open((view) => {
      view.schedules = [schedule];
    });
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('ul')?.textContent).toContain('<b>Morning</b>');
    expect(container.querySelector('h1')?.textContent).toBe('Schedule editor');
    (getByRole('button', { name: 'Open' }) as HTMLButtonElement).click();
    (getByRole('button', { name: 'New schedule' }) as HTMLButtonElement).click();
    expect(calls).toEqual(['open:s<1>', 'new']);
  });

  it('says so when there are no schedules, and still offers a new one', () => {
    const { container, getByRole } = open();
    expect(container.textContent).toContain('There are no schedules yet.');
    expect(getByRole('button', { name: 'New schedule' })).toBeTruthy();
  });

  it('is built from Cinder components, so it takes the host theme through the kit', () => {
    const { container } = open((view) => showForm(view));
    expect(container.querySelector('.cinder-section')).not.toBeNull();
    expect(container.querySelector('button.cinder-button')).not.toBeNull();
    expect(container.querySelector('#schedule-spec')).not.toBeNull();
  });

  it('shows what the schedule has, and the title of a change', () => {
    const { container } = open((view) => showForm(view));
    expect((container.querySelector('#schedule-spec') as HTMLInputElement).value).toBe('0 9 * * *');
    expect((container.querySelector('#schedule-description') as HTMLInputElement).value).toBe(
      '<b>Morning</b>',
    );
    expect(container.textContent).toContain('Change schedule');
    expect(container.textContent).toContain('Save changes');
  });

  it('shows each error on the field it belongs to', async () => {
    const { container } = open((view) => {
      showForm(view);
      view.errors = { spec: 'Not a cron expression', timeZone: 'Unknown zone' };
    });
    const spec = container.querySelector('#schedule-spec') as HTMLInputElement;
    const zone = container.querySelector('#schedule-time-zone') as HTMLInputElement;
    const description = container.querySelector('#schedule-description') as HTMLInputElement;
    expect(spec.getAttribute('aria-invalid')).toBe('true');
    expect(zone.getAttribute('aria-invalid')).toBe('true');
    expect(description.getAttribute('aria-invalid')).not.toBe('true');
    // The message is tied to its field, so a reader of the field hears it.
    const describedBy = spec.getAttribute('aria-describedby') ?? '';
    const text = describedBy
      .split(' ')
      .map((id) => container.querySelector(`#${id}`)?.textContent ?? '')
      .join(' ');
    expect(text).toContain('Not a cron expression');
  });

  it('tells the script about an edit and about a save, and offers Create for a new schedule', async () => {
    const { container, view, calls, getByRole } = open((state) => showForm(state, null));
    expect(container.textContent).toContain('New schedule');
    await fireEvent.input(container.querySelector('#schedule-spec') as HTMLInputElement, {
      target: { value: '6h' },
    });
    expect(calls).toEqual([`edit:${JSON.stringify({ spec: '6h' })}`]);
    expect(view.draft.spec).toBe('');
    // A panel's frame is sandboxed to allow-scripts alone, where a form never submits: the save
    // comes from the button's own click, and submitting the form saves nothing.
    await fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    expect(calls.at(-1)).not.toBe('save');
    const create = getByRole('button', { name: 'Create schedule' });
    expect(create.getAttribute('type')).not.toBe('submit');
    await fireEvent.click(create);
    expect(calls.at(-1)).toBe('save');
  });

  it('asks for an agent’s text when it is new, and for a workflow’s JSON when it runs one', async () => {
    const asking = open((view) => showForm(view, null));
    expect(asking.container.textContent).toContain('What each run sends the agent');
    asking.unmount();
    const keeping = open((view) => showForm(view));
    expect(keeping.container.textContent).toContain('Leave empty to keep the text');
    keeping.unmount();
    const workflow = open((view) => {
      showForm(view, null);
      view.draft.targetKind = 'workflow';
    });
    expect(workflow.container.querySelector('#schedule-workflow-input')).not.toBeNull();
    expect(workflow.container.querySelector('#schedule-input')).toBeNull();
  });

  it('shows nothing chosen for a new schedule, never the first agent, and keeps a target the list lacks', () => {
    const fresh = open((view) => showForm(view, null));
    const picker = fresh.container.querySelector('#schedule-target') as HTMLSelectElement;
    expect(picker.value).toBe('');
    expect([...picker.options].map((option) => option.textContent)).toEqual([
      'Choose an agent',
      'Writer',
      'Editor',
    ]);
    fresh.unmount();
    const hidden = open((view) =>
      showForm(view, { ...schedule, target: { kind: 'agent', agentName: 'secret' } }),
    );
    const kept = hidden.container.querySelector('#schedule-target') as HTMLSelectElement;
    expect(kept.value).toBe('secret');
  });

  it('draws a canceled schedule read-only and offers no way to save it', () => {
    const { container } = open((view) => showForm(view, { ...schedule, status: 'cancelled' }));
    expect(container.textContent).toContain('canceled, so it cannot be changed');
    expect((container.querySelector('#schedule-spec') as HTMLInputElement).disabled).toBe(true);
    expect((container.querySelector('#schedule-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers to read a changed schedule again, and refuses a save until it is', async () => {
    const { view, container, calls } = open((state) => {
      showForm(state);
      state.stale = true;
    });
    expect((container.querySelector('#schedule-save') as HTMLButtonElement).disabled).toBe(true);
    (container.querySelector('#schedule-reload') as HTMLButtonElement).click();
    expect(calls).toEqual(['reload']);
    view.stale = false;
    await tick();
    expect(container.querySelector('#schedule-reload')).toBeNull();
    expect((container.querySelector('#schedule-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers nothing while a save is in flight', async () => {
    const { view, container } = open((state) => showForm(state));
    view.busy = true;
    await tick();
    for (const id of ['schedule-save', 'schedule-back']) {
      expect((container.querySelector(`#${id}`) as HTMLButtonElement).disabled, id).toBe(true);
    }
    expect((container.querySelector('#schedule-spec') as HTMLInputElement).disabled).toBe(true);
  });

  it('announces its status in one polite live region', async () => {
    const { view, container } = open();
    view.status = 'Saved the changes.';
    view.tone = 'success';
    await tick();
    const status = container.querySelector('[role="status"][aria-live="polite"]');
    expect(status?.textContent).toBe('Saved the changes.');
    expect(status?.getAttribute('data-tone')).toBe('success');
  });
});
