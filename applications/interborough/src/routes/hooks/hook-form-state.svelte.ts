/**
 * Draft state for the hook editor: a name, the events the hook listens to, and what it does (a
 * signed message to a web address, a started workflow, or a notification). A plain rune-backed
 * class, so validation and the request it makes are testable without a DOM.
 *
 * The signing secret is write-only. It is never loaded into the form: an existing hook opens with
 * an empty secret field, and a field left empty keeps the secret the hook has.
 */
import type { Hook, HookActionType, HookChange, HookInput } from '../../lib/bureau-hooks.ts';
import { HOOKS_COPY } from './hook-copy.ts';
import type { DraftAction } from './hook-presentation.ts';

/** The shortest and longest signing secret the Bureau accepts. */
export const SECRET_MINIMUM_LENGTH = 16;
export const SECRET_MAXIMUM_LENGTH = 256;

/** The most events one hook may list. */
export const EVENTS_MAXIMUM = 64;

/** The longest hook name and notification title the Bureau accepts. */
const NAME_MAXIMUM_LENGTH = 100;
const TITLE_MAXIMUM_LENGTH = 200;

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
  actionType = $state<HookActionType>('webhook');
  url = $state('');
  signingSecret = $state('');
  workflowId = $state('');
  workflowInput = $state<'payload' | 'event'>('payload');
  title = $state('');
  /** Whether the hook's action is one a plugin contributed, which the editor keeps and does not edit. */
  pluginAction = $state(false);

  /** What the form held when it was last loaded from a hook, to tell whether anything was typed since. */
  private baseline = $state('');

  /** Whether the hook is not yet written, so a webhook needs its secret. */
  readonly isNew: boolean;

  constructor(isNew: boolean) {
    this.isNew = isNew;
  }

  /** Every field a person can type into, as one string. */
  private fingerprint(): string {
    return JSON.stringify([
      this.name,
      this.events,
      this.actionType,
      this.url,
      this.signingSecret,
      this.workflowId,
      this.workflowInput,
      this.title,
    ]);
  }

  /** Whether anything, a typed signing secret included, differs from the hook the form was loaded from. */
  get dirty(): boolean {
    return this.fingerprint() !== this.baseline;
  }

  /** Fills the form from a hook as the Bureau holds it. The secret is not part of that. */
  load(hook: Hook): void {
    this.name = hook.name ?? '';
    this.events = [...hook.events];
    this.signingSecret = '';
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

  /** The action as the hook's sentence reads it. */
  get draftAction(): DraftAction {
    switch (this.actionType) {
      case 'webhook':
        return { type: 'webhook', url: this.url.trim() };
      case 'start-workflow':
        return { type: 'start-workflow', workflowId: this.workflowId };
      case 'notify':
        return { type: 'notify' };
    }
  }

  /** Why the web address cannot be sent, or `undefined` when it can (or has not been typed yet). */
  get urlProblem(): string | undefined {
    const url = this.url.trim();
    return url === '' || isWebAddress(url) ? undefined : HOOKS_COPY.editor.webhook.urlInvalid;
  }

  /** Why the signing secret cannot be sent, or `undefined` when it can (or is left to keep). */
  get secretProblem(): string | undefined {
    if (this.signingSecret === '') return undefined;
    if (this.signingSecret.length < SECRET_MINIMUM_LENGTH) {
      return HOOKS_COPY.editor.webhook.secretTooShort;
    }
    return this.signingSecret.length > SECRET_MAXIMUM_LENGTH
      ? HOOKS_COPY.editor.webhook.secretTooLong
      : undefined;
  }

  /** Whether the form holds a hook the Bureau could accept. */
  get isValid(): boolean {
    if (this.events.length === 0 || this.events.length > EVENTS_MAXIMUM) return false;
    if (this.name.trim().length > NAME_MAXIMUM_LENGTH) return false;
    if (this.pluginAction) return true;
    switch (this.actionType) {
      case 'webhook':
        return (
          this.url.trim() !== '' &&
          this.urlProblem === undefined &&
          this.secretProblem === undefined &&
          (!this.isNew || this.signingSecret !== '')
        );
      case 'start-workflow':
        return this.workflowId !== '';
      case 'notify':
        return this.title.trim().length <= TITLE_MAXIMUM_LENGTH;
    }
  }

  /** The action as the Bureau takes it. */
  private action(): HookInput['action'] {
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
    }
  }

  /** What `bureau.hooks.create` takes. */
  toInput(): HookInput {
    return {
      events: [...this.events],
      action: this.action(),
      ...(this.name.trim() === '' ? {} : { name: this.name.trim() }),
      ...(this.actionType === 'webhook' ? { signingSecret: this.signingSecret } : {}),
    };
  }

  /**
   * What `bureau.hooks.update` changes. A hook whose action a plugin contributed keeps it: the
   * editor changes its name and events only. The secret goes only when one was typed. The action goes
   * only when it differs from the hook's, because the Bureau asks again whether a workflow is
   * allowed whenever an action is sent, and a rename is never held up by a workflow since paused.
   */
  toChange(hook: Hook): HookChange {
    return {
      name: this.name.trim() === '' ? null : this.name.trim(),
      events: [...this.events],
      ...(hook.action.type === 'plugin' || !this.actionChanged(hook)
        ? {}
        : { action: this.action() }),
      ...(this.actionType === 'webhook' && this.signingSecret !== ''
        ? { signingSecret: this.signingSecret }
        : {}),
    };
  }
}
