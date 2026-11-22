import {
  emptyScheduleDraft,
  type ScheduleDraft,
  type ScheduleFieldErrors,
} from '@lostgradient/interborough-plugin/schedule-form';

import type { PickerOption, ScheduleView } from './model.ts';

/** What the schedule editor shows. A change to any field redraws just what it feeds. */
export type EditorView = {
  /** `loading` until the first read settles, `failed` when the Bureau cannot be read at all. */
  phase: 'loading' | 'ready' | 'failed';
  /** The list of schedules to open one from, or the form of one schedule. */
  screen: 'choose' | 'form';
  /** The schedules the caller may change, in the order the Bureau lists them. */
  schedules: ScheduleView[];
  agents: readonly PickerOption[];
  workflows: readonly PickerOption[];
  /** The schedule the form shows, or `undefined` while it makes a new one. */
  source: ScheduleView | undefined;
  /** What the person is editing. */
  draft: ScheduleDraft;
  /** What is wrong with it, by field: said before a save, and by the Bureau's own answer after it. */
  errors: ScheduleFieldErrors;
  /** A save or a read is in flight: nothing more is offered. */
  busy: boolean;
  /** What the polite live region says now. */
  status: string;
  /** How the status is drawn. */
  tone: 'info' | 'success' | 'danger';
  /** The schedule changed since the form was opened, so a save is refused until it is read again. */
  stale: boolean;
  /** The host lets the page call its tools; without it nothing can be read or saved. */
  connected: boolean;
};

/** A view the page script updates and the component reads. */
export function createEditorView(): EditorView {
  const view: EditorView = $state({
    phase: 'loading',
    screen: 'choose',
    schedules: [],
    agents: [],
    workflows: [],
    source: undefined,
    draft: emptyScheduleDraft(),
    errors: {},
    busy: false,
    status: '',
    tone: 'info',
    stale: false,
    connected: true,
  });
  return view;
}
