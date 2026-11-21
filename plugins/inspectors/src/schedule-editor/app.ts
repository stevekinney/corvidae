/**
 * The schedule editor's page script (COR-2545), bundled into the `ui://` resource. It talks only to
 * its host over the MCP Apps bridge: it reads schedules, agents and workflows through
 * `bureau.schedules.list`, `bureau.schedules.get`, `bureau.agents.list` and `bureau.workflows.list`,
 * and saves through the host-only `bureau.schedules.create`, `update`, `pause` and `resume`, so the
 * host's authorization decides every call. It holds no credential and reaches no origin.
 *
 * What a form sends, and which field a fault belongs to, is the shared module
 * `@lostgradient/interborough-plugin/schedule-form`, which the application's own schedule page
 * imports too. A save is the calls that module plans, made in order: an update, then a pause or a
 * resume fenced by the revision the update answered, so a write another person made in between is
 * refused instead of overwritten. A save that stops half-way says which part was saved, and reads
 * the schedule again so the form shows what is now true.
 */
import { mountPanel } from '@lostgradient/cinder/panel';
import {
  emptyScheduleDraft,
  scheduleDraftErrors,
  scheduleDraftOf,
  scheduleSavePlan,
  type ScheduleDraft,
} from '@lostgradient/interborough-plugin/schedule-form';
import { App } from '@modelcontextprotocol/ext-apps';
import { unmount } from 'svelte';

import { followHostTheme } from '../host-theme.ts';
import {
  agentOptionsOf,
  everySchedule,
  isRecord,
  isScheduleView,
  scheduleOfTask,
  workflowOptionsOf,
  type ScheduleView,
} from './model.ts';
import { runSavePlan } from './save.ts';
import ScheduleEditor from './schedule-editor.svelte';
import { createEditorView } from './view.svelte.ts';

/** The most schedules one read lists. */
const LIST_LIMIT = 100;

/** Every tool the page calls: a read, or a write the plan names. Nothing else is ever sent. */
const DECLARED_TOOLS: ReadonlySet<string> = new Set([
  'bureau.schedules.list',
  'bureau.schedules.get',
  'bureau.schedules.create',
  'bureau.schedules.update',
  'bureau.schedules.pause',
  'bureau.schedules.resume',
  'bureau.agents.list',
  'bureau.workflows.list',
  'bureau.tasks.get',
]);

/** What a call of a save did once it was written, for "The part that did go through: …". */
const SAVED_PART: ReadonlyMap<string, string> = new Map([
  ['bureau.schedules.create', 'created the schedule'],
  ['bureau.schedules.update', 'saved the changes'],
  ['bureau.schedules.pause', 'paused it'],
  ['bureau.schedules.resume', 'resumed it'],
]);

/** The sentence that says which calls of a save were written before it stopped, or none. */
function savedParts(done: readonly string[]): string {
  return done.length === 0
    ? ''
    : ` The part that did go through: ${done.map((part) => SAVED_PART.get(part) ?? part).join(', ')}.`;
}

async function start(): Promise<void> {
  const root = document.getElementById('root');
  if (root === null) return;
  const app = new App({ name: 'bureau-schedule-editor', version: '1.0.0' });
  const applyHostTheme = followHostTheme(app);
  const view = createEditorView();
  let requested: { scheduleId?: string | undefined; taskId?: string | undefined } = {};
  let loaded = false;
  let tornDown = false;

  const say = (status: string, tone: 'info' | 'success' | 'danger' = 'info'): void => {
    if (tornDown) return;
    view.status = status;
    view.tone = tone;
  };

  /** One call, refused here unless the page declared the tool, so a plan can never send another. */
  const call = async (name: string, args: Record<string, unknown>) => {
    if (!DECLARED_TOOLS.has(name)) throw new Error(`The page does not call ${name}.`);
    return app.callServerTool({ name, arguments: args });
  };

  const readValue = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      const result = await call(name, args);
      return result.isError === true ? undefined : result.structuredContent;
    } catch {
      return undefined;
    }
  };

  /**
   * Reads every page of the list of schedules again, oldest first, so a newer schedule past the
   * first page can still be chosen; `false` when the Bureau did not answer a page.
   */
  const readSchedules = async (): Promise<boolean> => {
    const every = await everySchedule((offset) =>
      readValue('bureau.schedules.list', { limit: LIST_LIMIT, offset }),
    );
    if (every === undefined) return false;
    view.schedules = every.filter((schedule) => schedule.status !== 'cancelled');
    return true;
  };

  /** Reads one schedule; `undefined` when the Bureau did not answer one. */
  const readSchedule = async (id: string): Promise<ScheduleView | undefined> => {
    const value = await readValue('bureau.schedules.get', { scheduleId: id });
    return isScheduleView(value) ? value : undefined;
  };

  const show = (schedule: ScheduleView): void => {
    view.source = schedule;
    view.draft = scheduleDraftOf(schedule);
    view.errors = {};
    view.stale = false;
    view.screen = 'form';
  };

  const load = async (): Promise<void> => {
    view.connected = app.getHostCapabilities()?.serverTools !== undefined;
    if (!view.connected) {
      view.phase = 'ready';
      say('This host does not let the page call tools, so nothing can be read or saved.', 'danger');
      return;
    }
    const [listed, agents, workflows] = await Promise.all([
      readSchedules(),
      readValue('bureau.agents.list', {}),
      readValue('bureau.workflows.list', { limit: LIST_LIMIT }),
    ]);
    if (tornDown) return;
    if (!listed) {
      view.phase = 'failed';
      return;
    }
    view.agents = agentOptionsOf(agents) ?? [];
    view.workflows = workflowOptionsOf(workflows) ?? [];
    view.phase = 'ready';
    const missing = [
      agentOptionsOf(agents) === undefined ? 'agents' : '',
      workflowOptionsOf(workflows) === undefined ? 'workflows' : '',
    ].filter((name) => name !== '');
    if (missing.length > 0) say(`The ${missing.join(' and ')} could not be listed.`, 'danger');
  };

  const open = async (id: string): Promise<void> => {
    if (view.busy) return;
    view.busy = true;
    try {
      const schedule = await readSchedule(id);
      if (schedule === undefined) say('That schedule could not be read.', 'danger');
      else {
        show(schedule);
        say(
          schedule.status === 'cancelled'
            ? 'This schedule was canceled.'
            : `Changing ${schedule.description ?? 'the schedule'}.`,
        );
      }
    } finally {
      view.busy = false;
    }
  };

  const startNew = (): void => {
    if (view.busy) return;
    view.source = undefined;
    view.draft = emptyScheduleDraft();
    view.errors = {};
    view.stale = false;
    view.screen = 'form';
    say('Making a new schedule.');
  };

  const back = async (): Promise<void> => {
    if (view.busy) return;
    view.screen = 'choose';
    view.source = undefined;
    view.errors = {};
    view.stale = false;
    say('');
    await readSchedules();
  };

  const edit = (change: Partial<ScheduleDraft>): void => {
    Object.assign(view.draft, change);
    // What the person changed no longer shows the problem it showed, until a save finds it again.
    // A change of kind clears the target, the text and the input, which the new kind asks afresh.
    const cleared = new Set<string>(Object.keys(change));
    if (change.targetKind !== undefined) {
      for (const field of ['target', 'input', 'workflowInput']) cleared.add(field);
    }
    view.errors = Object.fromEntries(
      Object.entries(view.errors).filter(([field]) => !cleared.has(field)),
    );
  };

  /** Reads the saved schedule again so the form shows what is now true; what was typed to send is spent. */
  const settle = async (id: string, outcome: string, tone: 'success' | 'danger'): Promise<void> => {
    const fresh = await readSchedule(id);
    if (fresh === undefined) {
      // The write is done: saving the same draft again would make a second schedule, or write over
      // one the form no longer shows. The form takes no save until the schedule is opened again.
      view.stale = true;
      say(
        `${outcome} It could not be read again, so go back and open it before changing it further.`,
        'danger',
      );
      await readSchedules();
      return;
    }
    show(fresh);
    say(outcome, tone);
    await readSchedules();
  };

  const save = async (): Promise<void> => {
    if (view.busy || view.stale) return;
    const problems = scheduleDraftErrors(view.draft, view.source);
    if (Object.keys(problems).length > 0) {
      view.errors = problems;
      say('Not saved. Fix the fields that show a problem.', 'danger');
      return;
    }
    const plan = scheduleSavePlan(view.draft, view.source);
    if (plan.length === 0) {
      say('Nothing has changed.');
      return;
    }
    view.busy = true;
    view.errors = {};
    const making = view.source === undefined;
    try {
      const outcome = await runSavePlan(plan, view.source, call);
      if (outcome.kind === 'saved') {
        await settle(
          outcome.id,
          making ? 'Created the schedule.' : 'Saved the changes.',
          'success',
        );
        return;
      }
      const saved = savedParts(outcome.done);
      // What may have been written is read back, and the form is rebuilt from it: the draft and the
      // revision it is fenced by stay one pair, so a field another caller changed meanwhile is
      // shown, never sent back over their write under the newer revision.
      if (outcome.id !== undefined && (outcome.done.length > 0 || outcome.kind === 'unanswered')) {
        const fresh = await readSchedule(outcome.id);
        if (fresh !== undefined) {
          view.source = fresh;
          view.draft = scheduleDraftOf(fresh);
        }
      }
      if (outcome.kind === 'refused') {
        view.errors = outcome.fault.fields;
        view.stale = outcome.fault.currentRevision !== undefined;
        const reason = view.stale
          ? 'The schedule changed since it was opened. Read it again, then make the change again.'
          : outcome.fault.message;
        say(`Not saved: ${reason}${saved}`, 'danger');
      } else if (outcome.kind === 'unreadable') {
        say(
          `Not saved: the Bureau's answer to ${outcome.tool} was not one this page reads.${saved}`,
          'danger',
        );
      } else if (outcome.id === undefined) {
        // A create the host never answered may have been written: another one would make a second,
        // so the form takes no save until the person goes back to the list and opens it again.
        view.stale = true;
        say(
          'The host did not answer, so the schedule may or may not have been made. Look at the list before trying again.',
          'danger',
        );
      } else {
        say(
          `The host did not answer ${outcome.tool}, so the form was read again to show what the schedule holds. Check it before saving again.${saved}`,
          'danger',
        );
      }
    } finally {
      view.busy = false;
    }
  };

  const reload = async (): Promise<void> => {
    const id = view.source?.id;
    if (id !== undefined) await open(id);
  };

  const handlers = {
    onOpen: (id: string) => void open(id),
    onNew: startNew,
    onBack: () => void back(),
    onSave: () => void save(),
    onReload: () => void reload(),
    onEdit: edit,
  };
  const mounted = mountPanel(ScheduleEditor, { target: root, props: { view, handlers } });

  /**
   * Opens what the host asked for: the schedule it named, or the schedule that started the run it
   * is showing. A run something else started, or a host that named neither, leaves the list.
   */
  const openRequested = async (): Promise<void> => {
    let id = requested.scheduleId;
    if (id === undefined && requested.taskId !== undefined) {
      id = scheduleOfTask(await readValue('bureau.tasks.get', { taskId: requested.taskId }));
      if (id === undefined) {
        say('No schedule started this run, so here are the schedules.');
        return;
      }
    }
    if (id !== undefined) await open(id);
  };

  app.ontoolinput = (params) => {
    const input = isRecord(params.arguments) ? params.arguments : {};
    const named = (key: string): string | undefined => {
      const value: unknown = Object.hasOwn(input, key) ? input[key] : undefined;
      return typeof value === 'string' && value !== '' ? value : undefined;
    };
    requested = { scheduleId: named('scheduleId'), taskId: named('taskId') };
    if (loaded) void openRequested();
  };
  app.onteardown = async () => {
    tornDown = true;
    void unmount(mounted);
    root.replaceChildren();
    return {};
  };
  await app.connect();
  applyHostTheme();
  await load();
  loaded = true;
  await openRequested();
}

void start();
