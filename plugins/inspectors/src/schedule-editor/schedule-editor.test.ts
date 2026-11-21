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

  it('draws no schedules as an empty state whose one action makes a schedule', () => {
    const { container, getAllByRole, getByRole, calls } = open();
    expect(container.querySelector('.cinder-empty-state')).not.toBeNull();
    expect(container.textContent).toContain('No schedules yet');
    // The empty state's action is the only way to make one: no second button beside it.
    expect(getAllByRole('button', { name: 'New schedule' })).toHaveLength(1);
    (getByRole('button', { name: 'New schedule' }) as HTMLButtonElement).click();
    expect(calls).toEqual(['new']);
  });

  it('draws no status box until there is something to say, and keeps the live region', async () => {
    const { view, container } = open();
    const region = container.querySelector('[role="status"][aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region?.querySelector('.cinder-callout')).toBeNull();
    view.status = 'Saved the changes.';
    await tick();
    expect(region?.querySelector('.cinder-callout')).not.toBeNull();
    view.status = '';
    await tick();
    expect(region?.querySelector('.cinder-callout')).toBeNull();
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

  it('draws a canceled schedule read-only, says so once, and offers no way to save it', () => {
    const { container } = open((view) => {
      showForm(view, { ...schedule, status: 'cancelled' });
      view.status = 'This schedule was canceled, so it cannot be changed.';
    });
    const said = container.textContent.match(/canceled, so it cannot be changed/g) ?? [];
    expect(said).toHaveLength(1);
    expect((container.querySelector('#schedule-spec') as HTMLInputElement).disabled).toBe(true);
    expect((container.querySelector('#schedule-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers to read a changed schedule again as the primary action, and refuses a save until it is', async () => {
    const { view, container, calls } = open((state) => {
      showForm(state);
      state.stale = true;
    });
    const reload = container.querySelector('#schedule-reload') as HTMLButtonElement;
    expect(reload.className).toContain('button-variant-primary');
    expect((container.querySelector('#schedule-save') as HTMLButtonElement).disabled).toBe(true);
    expect(
      (container.querySelector('#schedule-save') as HTMLButtonElement).className,
    ).not.toContain('button-variant-primary');
    reload.click();
    expect(calls).toEqual(['reload']);
    view.stale = false;
    await tick();
    expect(container.querySelector('#schedule-reload')).toBeNull();
    expect((container.querySelector('#schedule-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers no "Read it again" when no schedule was opened, and makes the way back primary', () => {
    // A create the host never answered locks the form, and there is no schedule to read again.
    const { container, calls } = open((state) => {
      showForm(state, null);
      state.stale = true;
    });
    expect(container.querySelector('#schedule-reload')).toBeNull();
    expect(container.textContent).not.toContain('Read it again');
    const back = container.querySelector('#schedule-back') as HTMLButtonElement;
    expect(back.className).toContain('button-variant-primary');
    expect((container.querySelector('#schedule-save') as HTMLButtonElement).disabled).toBe(true);
    back.click();
    expect(calls).toEqual(['back']);
  });

  it('shows the save in progress and offers nothing else while it is in flight', async () => {
    const { view, container } = open((state) => showForm(state));
    view.busy = true;
    await tick();
    const saving = container.querySelector('#schedule-save') as HTMLButtonElement;
    expect(saving.getAttribute('aria-busy')).toBe('true');
    expect(saving.getAttribute('aria-disabled')).toBe('true');
    expect(saving.hasAttribute('data-cinder-loading')).toBe(true);
    // The Button's own live region says it, and the page's status says nothing, so it is read once.
    expect(container.querySelector('[data-cinder-button-status]')?.textContent).toBe(
      'Saving the changes…',
    );
    expect(container.querySelector('.editor-status')?.textContent.trim()).toBe('');
    expect(container.querySelector('.editor-status')?.getAttribute('data-empty')).toBe('true');
    expect((container.querySelector('#schedule-back') as HTMLButtonElement).disabled).toBe(true);
    expect((container.querySelector('#schedule-spec') as HTMLInputElement).disabled).toBe(true);
  });

  it('says a new schedule is being created while it is', async () => {
    const { view, container } = open((state) => showForm(state, null));
    view.busy = true;
    await tick();
    expect(container.querySelector('[data-cinder-button-status]')?.textContent).toBe(
      'Creating the schedule…',
    );
  });

  it('announces its status in one polite live region', async () => {
    const { view, container } = open();
    view.status = 'Saved the changes.';
    view.tone = 'success';
    await tick();
    const status = container.querySelector('[role="status"][aria-live="polite"]');
    expect(status?.textContent.trim()).toBe('Saved the changes.');
    expect(status?.getAttribute('data-tone')).toBe('success');
  });
});
