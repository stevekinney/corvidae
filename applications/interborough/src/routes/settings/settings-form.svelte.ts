/**
 * The settings page's draft: what each key holds now (the snapshot the page last read), what the
 * person has changed it to, and what that says to the Bureau. A key is _dirty_ when its draft is not
 * what the snapshot holds, and one `update` sends the dirty keys against the snapshot's revision.
 * A key the deployment locked is never dirty, because its control does not edit.
 *
 * A draft is the JSON value the key takes. A control that edits JSON as text (`holdsJson`) also keeps
 * the text, because what is typed is not JSON until it parses, and a draft that does not parse is
 * the key's error and never reaches the Bureau. A key edited through a `SchemaForm` (`holdsForm`)
 * is checked against its schema after each edit, and what that check finds is the key's error until
 * the next edit; nothing is sent while a check is still running.
 */
import { SvelteMap } from 'svelte/reactivity';

import type { SettingsSnapshot } from '../../lib/bureau-settings.ts';
import { holdsForm, holdsJson, type Control } from './settings-controls.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether two JSON values are equal, whatever the order of an object's keys. */
export function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameValue(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const names = Object.keys(left);
    return (
      names.length === Object.keys(right).length &&
      names.every((name) => Object.hasOwn(right, name) && sameValue(left[name], right[name]))
    );
  }
  return Object.is(left, right);
}

/**
 * The text a JSON editor starts from for a value: pretty-printed JSON, or nothing for a key with no
 * value.
 */
export function textOf(_control: Control, value: unknown): string {
  if (value === undefined) return '';
  return JSON.stringify(value, null, 2);
}

function numberProblem(control: Extract<Control, { kind: 'number' }>, value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a number.';
  if (control.integer && !Number.isInteger(value)) return 'Enter a whole number.';
  if (control.minimum !== undefined && value < control.minimum) {
    return `Enter ${String(control.minimum)} or more.`;
  }
  if (control.exclusiveMinimum !== undefined && value <= control.exclusiveMinimum) {
    return `Enter more than ${String(control.exclusiveMinimum)}.`;
  }
  if (control.maximum !== undefined && value > control.maximum) {
    return `Enter ${String(control.maximum)} or less.`;
  }
  return undefined;
}

/** Whether `text` matches a schema's `pattern`. A pattern JavaScript cannot read checks nothing, and the Bureau still does. */
function matches(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(text);
  } catch {
    return true;
  }
}

/**
 * What is wrong with a draft, or `undefined` when it can be sent. It is the check that stops a
 * draft that cannot be a value (an empty required number); what the Bureau refuses beyond it, such
 * as a value its schema does not take, is the Bureau's to say.
 */
export function problemWith(
  control: Control,
  draft: unknown,
  hadValue: boolean,
): string | undefined {
  switch (control.kind) {
    case 'toggle':
      return undefined;
    case 'select':
      return draft === undefined || (typeof draft === 'string' && control.options.includes(draft))
        ? undefined
        : 'Choose one of the options.';
    case 'text':
      if (draft === undefined || draft === '') return hadValue ? 'Enter a value.' : undefined;
      if (typeof draft !== 'string') return 'Enter text.';
      return control.pattern !== undefined && !matches(control.pattern, draft)
        ? 'That is not in the form this setting takes.'
        : undefined;
    case 'number':
      if (draft === undefined || draft === null) return hadValue ? 'Enter a number.' : undefined;
      return numberProblem(control, draft);
    case 'choice':
      if (draft === undefined) return undefined;
      return typeof draft === 'string' && draft !== '' ? undefined : 'Choose one of the options.';
    case 'form':
    case 'switch-form':
      // A `SchemaForm`'s value is checked against its schema after each edit (`SettingsForm.set`).
      return undefined;
    case 'json':
      return draft === undefined && hadValue ? 'Enter a JSON value.' : undefined;
  }
}

/** Checks a `SchemaForm` key's value against its schema: the problem, or `undefined` when the value holds. */
export type FormValidator = (key: string, value: unknown) => Promise<string | undefined>;

/** The draft of the settings page. */
export class SettingsForm {
  /** The revision of the snapshot the draft starts from, which an update is compared against. */
  revision = $state(0);
  /** Counts the times the draft started over, so a `SchemaForm`, which only seeds from its value, is made again. */
  generation = $state(0);
  /** What each key held when the snapshot was read; a key with no value is absent. */
  #baseline = $state.raw<Readonly<Record<string, unknown>>>({});
  #drafts = new SvelteMap<string, unknown>();
  #texts = new SvelteMap<string, string>();
  #parseErrors = new SvelteMap<string, string>();
  #formProblems = new SvelteMap<string, string>();
  /** The check running for each form key, by a number that says which edit it belongs to. */
  #checking = new SvelteMap<string, number>();
  #inflight = new Set<Promise<void>>();
  #lastObjects = new Map<string, Record<string, unknown>>();
  #checks = 0;
  readonly #controls: ReadonlyMap<string, Control>;
  readonly #locked: (key: string) => boolean;
  readonly #validate: FormValidator;

  constructor(
    controls: ReadonlyMap<string, Control>,
    locked: (key: string) => boolean,
    validate: FormValidator = () => Promise.resolve(undefined),
  ) {
    this.#controls = controls;
    this.#locked = locked;
    this.#validate = validate;
  }

  /** Starts over from a snapshot: every draft is what the snapshot holds, and nothing is dirty. */
  load(snapshot: SettingsSnapshot): void {
    this.revision = snapshot.revision;
    this.#baseline = snapshot.values;
    this.#reset();
  }

  #reset(): void {
    this.#drafts.clear();
    this.#texts.clear();
    this.#parseErrors.clear();
    this.#formProblems.clear();
    this.#checking.clear();
    for (const [key, control] of this.#controls) {
      const value = this.#baseline[key];
      this.#drafts.set(key, value);
      if (holdsJson(control)) this.#texts.set(key, textOf(control, value));
    }
    this.generation += 1;
  }

  /** The draft of a key. */
  draft(key: string): unknown {
    return this.#drafts.get(key);
  }

  /** What a key held when the snapshot was read. */
  baseline(key: string): unknown {
    return this.#baseline[key];
  }

  /** The text of a JSON editor. */
  text(key: string): string {
    return this.#texts.get(key) ?? '';
  }

  /** Sets a key's draft to a value. */
  set(key: string, value: unknown): void {
    this.#drafts.set(key, value);
    this.#parseErrors.delete(key);
    const control = this.#controls.get(key);
    if (control !== undefined && holdsForm(control)) {
      if (isRecord(value)) this.#lastObjects.set(key, value);
      const check = this.#check(key, value);
      this.#inflight.add(check);
      void check.finally(() => this.#inflight.delete(check));
    }
  }

  async #check(key: string, value: unknown): Promise<void> {
    this.#formProblems.delete(key);
    if (value === undefined || value === false) {
      this.#checking.delete(key);
      return;
    }
    this.#checks += 1;
    const check = this.#checks;
    this.#checking.set(key, check);
    let problem: string | undefined;
    try {
      problem = await this.#validate(key, value);
    } catch {
      problem = 'This value could not be checked.';
    }
    // A later edit, or starting over, owns the key now.
    if (this.#checking.get(key) !== check) return;
    this.#checking.delete(key);
    if (problem !== undefined) this.#formProblems.set(key, problem);
  }

  /**
   * Turns a switch that is `false` or an object (`tools.humanInput`) off or on. On, it is the object
   * its form last held, or an empty one.
   */
  setSwitch(key: string, on: boolean): void {
    this.set(key, on ? (this.#lastObjects.get(key) ?? {}) : false);
  }

  /** Sets a JSON editor's text, and the draft to what it parses to when it does. */
  setText(key: string, text: string): void {
    this.#texts.set(key, text);
    if (text.trim() === '') {
      this.#drafts.set(key, undefined);
      this.#parseErrors.delete(key);
      return;
    }
    try {
      this.#drafts.set(key, JSON.parse(text) as unknown);
      this.#parseErrors.delete(key);
    } catch (error) {
      this.#parseErrors.set(key, error instanceof Error ? error.message : 'Not valid JSON.');
    }
  }

  /** Whether a key's draft is not what the snapshot holds. A locked key never is. */
  isDirty(key: string): boolean {
    if (this.#locked(key)) return false;
    // A draft that does not parse has not changed the value yet, but it is not the snapshot's either.
    if (this.#parseErrors.has(key)) return true;
    return !sameValue(this.#drafts.get(key), this.#baseline[key]);
  }

  /** What is wrong with a key's draft, or `undefined`. */
  error(key: string): string | undefined {
    const control = this.#controls.get(key);
    if (control === undefined || !this.isDirty(key)) return undefined;
    return (
      this.#parseErrors.get(key) ??
      this.#formProblems.get(key) ??
      problemWith(control, this.#drafts.get(key), this.#baseline[key] !== undefined)
    );
  }

  /** The dirty keys, in the schema's order. */
  get dirtyKeys(): readonly string[] {
    return [...this.#controls.keys()].filter((key) => this.isDirty(key));
  }

  /** Whether a change can be sent: something is dirty, nothing dirty has a problem, and no check is running. */
  get canSave(): boolean {
    const dirty = this.dirtyKeys;
    return (
      dirty.length > 0 &&
      this.#checking.size === 0 &&
      dirty.every((key) => this.error(key) === undefined)
    );
  }

  /** The patch an update sends: the dirty keys, each with its draft. */
  patch(): Record<string, unknown> {
    return Object.fromEntries(this.dirtyKeys.map((key) => [key, this.#drafts.get(key)]));
  }

  /** Resolves when no check of a form key's value is still running, so a save asked for right after an edit sees its outcome. */
  async settled(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.all(this.#inflight);
  }

  /** Puts every key back to what the snapshot holds. */
  discard(): void {
    this.#reset();
  }
}
