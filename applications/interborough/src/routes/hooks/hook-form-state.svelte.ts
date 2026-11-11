/**
 * Draft state for the hook editor: a name, the events the hook listens to, the one subject it is
 * limited to, and what it does (a signed message to a web address, a started workflow, or a
 * notification). A plain rune-backed class, so validation and the request it makes are testable
 * without a DOM.
 *
 * The signing secret is not part of the draft: the Bureau makes one for a new webhook and shows it
 * once (`hook-secret-once.ts`), and Replace on a saved hook makes another, so no form field holds it.
 */
import type {
  Hook,
  HookActionType,
  HookChange,
  HookInput,
  HookScope,
  HookScopeInput,
} from '../../lib/bureau-hooks.ts';
import { HOOKS_COPY } from './hook-copy.ts';
import { isScopeKind, type DraftAction } from './hook-presentation.ts';

/** The most events one hook may list. */
export const EVENTS_MAXIMUM = 64;

/** The longest hook name the Bureau accepts. */
const NAME_MAXIMUM_LENGTH = 100;

/** The fields a problem can belong to, which the page maps to the control that holds each. */
export type HookProblemField = 'event' | 'only-for' | 'url' | 'workflow' | 'name';

/** One reason the hook cannot be saved yet, said beside the field it belongs to. */
export type HookProblem = { readonly field: HookProblemField; readonly message: string };

/** Whether `text` reads as a web address the Bureau could accept: http or https, no user name or password. */
function isWebAddress(text: string): boolean {
  try {
    const url = new URL(text);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

export class HookFormState {
  name = $state('');
  events = $state<string[]>([]);
  /** What Only for limits the hook to: the kind of subject (empty for everything) and which one. */
  scopeKind = $state('');
  scopeId = $state('');
  actionType = $state<HookActionType>('webhook');
  url = $state('');
  workflowId = $state('');
  workflowInput = $state<'payload' | 'event'>('payload');
  title = $state('');
  /** The action kind a plugin contributes that the hook runs, chosen instead of a built-in action. */
  contributedKind = $state<{ readonly plugin: string; readonly kind: string } | null>(null);
  /** The fields of the contributed kind's configuration. */
  contributedConfiguration = $state<Record<string, unknown>>({});
  /** Whether the hook's action is one a plugin contributed, which the editor keeps and does not edit. */
  pluginAction = $state(false);

  /** What the form held when it was last loaded from a hook, to tell whether anything was typed since. */
  private baseline = $state('');

  /** Whether the hook is not yet written. */
  readonly isNew: boolean;

  constructor(isNew: boolean) {
    this.isNew = isNew;
  }

  /** Every field a person can type into, as one string. */
  private fingerprint(): string {
    return JSON.stringify([
      this.name,
      this.events,
      this.scopeKind,
      this.scopeId,
      this.actionType,
      this.url,
      this.workflowId,
      this.workflowInput,
      this.title,
      this.contributedKind,
      this.contributedConfiguration,
    ]);
  }

  /** Whether anything differs from the hook the form was loaded from. */
  get dirty(): boolean {
    return this.fingerprint() !== this.baseline;
  }

  /** Fills the form from a hook as the Bureau holds it. The secret is not part of that. */
  load(hook: Hook): void {
    this.name = hook.name ?? '';
    this.events = [...hook.events];
    this.scopeKind = hook.scope?.kind ?? '';
    this.scopeId = hook.scope?.id ?? '';
    switch (hook.action.type) {
      case 'webhook':
        this.actionType = 'webhook';
        this.url = hook.action.url;
        break;
      case 'start-workflow':
        this.actionType = 'start-workflow';
        this.workflowId = hook.action.workflowId;
        this.workflowInput = hook.action.input;
        break;
      case 'notify':
        this.actionType = 'notify';
        this.title = hook.action.title ?? '';
        break;
      case 'plugin':
        this.pluginAction = true;
        break;
    }
    this.baseline = this.fingerprint();
  }

  /** The scope as the hook's sentence reads it: `null` until both of its fields are chosen. */
  get draftScope(): HookScope | null {
    return this.scopeKind === '' || this.scopeId === ''
      ? null
      : { kind: this.scopeKind, id: this.scopeId };
  }

  /** The kind of action the form writes: a built-in one, or `plugin` for a contributed kind. */
  get effectiveType(): HookActionType | 'plugin' {
    return this.contributedKind === null ? this.actionType : 'plugin';
  }

  /** The action as the hook's sentence reads it. */
  get draftAction(): DraftAction {
    if (this.contributedKind !== null) {
      return {
        type: 'plugin',
        plugin: this.contributedKind.plugin,
        kind: this.contributedKind.kind,
      };
    }
    switch (this.actionType) {
      case 'webhook':
        return { type: 'webhook', url: this.url.trim() };
      case 'start-workflow':
        return { type: 'start-workflow', workflowId: this.workflowId };
      case 'notify':
        return { type: 'notify' };
    }
  }

  /**
   * Why the web address cannot be sent, or `undefined` when it can (or has not been typed yet). Text
   * that does not start with a scheme says how to start it; an address with a user name, a
   * password or a fragment says which of those the Bureau refuses.
   */
  get urlProblem(): string | undefined {
    const url = this.url.trim();
    if (url === '') return undefined;
    if (isWebAddress(url)) return undefined;
    return /^https?:\/\//i.test(url)
      ? HOOKS_COPY.editor.webhook.urlInvalid
      : HOOKS_COPY.editor.webhook.urlMissing;
  }

  /**
   * What stops the hook being saved, in the order of the steps: each names the field it belongs to,
   * so the page can say it beside that field and move focus to the first. Empty when the Bureau
   * could accept the hook.
   */
  get problems(): HookProblem[] {
    const copy = HOOKS_COPY.editor;
    const found: HookProblem[] = [];
    if (this.events.length === 0) found.push({ field: 'event', message: copy.event.required });
    else if (this.events.length > EVENTS_MAXIMUM) {
      found.push({ field: 'event', message: copy.event.tooMany });
    }
    if (this.scopeKind !== '' && this.scopeId === '') {
      found.push({ field: 'only-for', message: copy.onlyFor.required });
    }
    if (!this.pluginAction && this.contributedKind === null) {
      if (this.actionType === 'webhook') {
        const url = this.url.trim();
        if (url === '') found.push({ field: 'url', message: copy.webhook.urlMissing });
        else if (this.urlProblem !== undefined) {
          found.push({ field: 'url', message: this.urlProblem });
        }
      } else if (this.actionType === 'start-workflow' && this.workflowId === '') {
        found.push({ field: 'workflow', message: copy.workflow.required });
      }
    }
    if (this.name.trim().length > NAME_MAXIMUM_LENGTH) {
      found.push({ field: 'name', message: copy.check.nameTooLong });
    }
    return found;
  }

  /** Whether the form holds a hook the Bureau could accept. */
  get isValid(): boolean {
    return this.problems.length === 0;
  }

  /** The action as the Bureau takes it. */
  private action(): HookInput['action'] {
    if (this.contributedKind !== null) {
      return {
        type: 'plugin',
        plugin: this.contributedKind.plugin,
        kind: this.contributedKind.kind,
        configuration: { ...this.contributedConfiguration },
      };
    }
    switch (this.actionType) {
      case 'webhook':
        return { type: 'webhook', url: this.url.trim() };
      case 'start-workflow':
        return {
          type: 'start-workflow',
          workflowId: this.workflowId,
          input: this.workflowInput,
        };
      case 'notify':
        return this.title.trim() === ''
          ? { type: 'notify' }
          : { type: 'notify', title: this.title.trim() };
    }
  }

  /** The scope as the Bureau takes it, or `undefined` for a hook that runs for everything. */
  private scope(): HookScopeInput | undefined {
    return isScopeKind(this.scopeKind) && this.scopeId !== ''
      ? { kind: this.scopeKind, id: this.scopeId }
      : undefined;
  }

  /** Whether the action the form holds differs from the one `hook` has. */
  private actionChanged(hook: Hook): boolean {
    const draft = this.action();
    const current = hook.action;
    if (draft.type !== current.type) return true;
    switch (draft.type) {
      case 'webhook':
        return current.type !== 'webhook' || draft.url !== current.url;
      case 'start-workflow':
        return (
          current.type !== 'start-workflow' ||
          draft.workflowId !== current.workflowId ||
          draft.input !== current.input
        );
      case 'notify':
        return current.type !== 'notify' || (draft.title ?? null) !== current.title;
      case 'plugin':
        return true;
    }
  }

  /** What `bureau.hooks.create` takes. */
  toInput(): HookInput {
    const scope = this.scope();
    return {
      events: [...this.events],
      action: this.action(),
      ...(scope === undefined ? {} : { scope }),
      ...(this.name.trim() === '' ? {} : { name: this.name.trim() }),
    };
  }

  /**
   * What `bureau.hooks.update` changes. A hook whose action a plugin contributed keeps it: the
   * editor changes its name and events only. The action goes
   * only when it differs from the hook's, because the Bureau asks again whether a workflow is
   * allowed whenever an action is sent, and a rename is never held up by a workflow since paused.
   * The scope goes only when it changed, so a kind this page does not know is left as it is, and the
   * events go only when they changed, because the Bureau asks whether the scope fits them whenever
   * they are sent, which would refuse a rename of a hook whose scope kind this page does not know.
   */
  toChange(hook: Hook): HookChange {
    const scopeChanged =
      this.scopeKind !== (hook.scope?.kind ?? '') || this.scopeId !== (hook.scope?.id ?? '');
    const eventsChanged =
      this.events.length !== hook.events.length ||
      this.events.some((event, index) => event !== hook.events[index]);
    return {
      name: this.name.trim() === '' ? null : this.name.trim(),
      ...(eventsChanged ? { events: [...this.events] } : {}),
      ...(scopeChanged ? { scope: this.scope() ?? null } : {}),
      ...(hook.action.type === 'plugin' || !this.actionChanged(hook)
        ? {}
        : { action: this.action() }),
    };
  }
}
