/**
 * The settings page's draft: what each key holds now (the snapshot the page last read), what the
 * person has changed it to, and what that says to the Bureau. A key is _dirty_ when its draft is not
 * what the snapshot holds, and one `update` sends the dirty keys against the snapshot's revision.
 * A key the deployment locked is never dirty, because its control does not edit.
 *
 * A draft is the JSON value the key takes. A control that edits JSON as text (`holdsJson`) also keeps
 * the text, because what is typed is not JSON until it parses, and a draft that does not parse is
 * the key's error and never reaches the Bureau.
 */
import { SvelteMap } from 'svelte/reactivity';

import type { SettingsSnapshot } from '../../lib/bureau-settings.ts';
import { holdsJson, type Control, type NumberField } from './settings-controls.ts';

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
 * value and for the `false` of a switch, whose editor is shown only while the switch is on.
 */
export function textOf(control: Control, value: unknown): string {
  if (value === undefined || (control.kind === 'switch-json' && value === false)) return '';
  return JSON.stringify(value, null, 2);
}

function numberProblem(field: NumberField, value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a number.';
  if (field.integer && !Number.isInteger(value)) return 'Enter a whole number.';
  if (field.minimum !== undefined && value < field.minimum) {
    return `Enter ${String(field.minimum)} or more.`;
  }
  if (field.exclusiveMinimum !== undefined && value <= field.exclusiveMinimum) {
    return `Enter more than ${String(field.exclusiveMinimum)}.`;
  }
  if (field.maximum !== undefined && value > field.maximum) {
    return `Enter ${String(field.maximum)} or less.`;
  }
  return undefined;
}

/** The first problem with an object's number fields: a required one that is empty, or any one that does not hold. */
function fieldsProblem(fields: readonly NumberField[], draft: unknown): string | undefined {
  if (!isRecord(draft)) return 'Enter a number.';
  for (const field of fields) {
    const value = draft[field.name];
    if (value === undefined || value === null) {
      if (field.required) return 'Enter a number.';
      continue;
    }
    const problem = numberProblem(field, value);
    if (problem !== undefined) return problem;
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
      return numberProblem({ name: '', required: true, ...control }, draft);
    case 'fields':
      return draft === undefined && !hadValue ? undefined : fieldsProblem(control.fields, draft);
    case 'literal-or-fields':
      if (draft === undefined) return undefined;
      if (typeof draft === 'string') {
        return control.literals.includes(draft) ? undefined : 'Choose one of the options.';
      }
      return fieldsProblem(control.fields, draft);
    case 'switch-json':
      return draft === false || isRecord(draft) ? undefined : 'Enter a JSON object.';
    case 'json':
      return draft === undefined && hadValue ? 'Enter a JSON value.' : undefined;
  }
}

/** The draft of the settings page. */
export class SettingsForm {
  /** The revision of the snapshot the draft starts from, which an update is compared against. */
  revision = $state(0);
  /** What each key held when the snapshot was read; a key with no value is absent. */
  #baseline = $state.raw<Readonly<Record<string, unknown>>>({});
  #drafts = new SvelteMap<string, unknown>();
  #texts = new SvelteMap<string, string>();
  #parseErrors = new SvelteMap<string, string>();
  readonly #controls: ReadonlyMap<string, Control>;
  readonly #locked: (key: string) => boolean;

  constructor(controls: ReadonlyMap<string, Control>, locked: (key: string) => boolean) {
    this.#controls = controls;
    this.#locked = locked;
  }

  /** Starts over from a snapshot: every draft is what the snapshot holds, and nothing is dirty. */
  load(snapshot: SettingsSnapshot): void {
    this.revision = snapshot.revision;
    this.#baseline = snapshot.values;
    this.#drafts.clear();
    this.#texts.clear();
    this.#parseErrors.clear();
    for (const [key, control] of this.#controls) {
      const value = snapshot.values[key];
      this.#drafts.set(key, value);
      if (holdsJson(control)) this.#texts.set(key, textOf(control, value));
    }
  }

  /** The draft of a key. */
  draft(key: string): unknown {
    return this.#drafts.get(key);
  }

  /** The text of a JSON editor. */
  text(key: string): string {
    return this.#texts.get(key) ?? '';
  }

  /** Sets a key's draft to a value. */
  set(key: string, value: unknown): void {
    this.#drafts.set(key, value);
    this.#parseErrors.delete(key);
    if (this.#controls.get(key)?.kind === 'switch-json' && isRecord(value)) {
      this.#texts.set(key, JSON.stringify(value, null, 2));
    }
  }

  /**
   * Turns a switch that is `false` or an object (`tools.humanInput`) off or on. On, it is the object
   * its editor holds, or an empty one when the editor holds none that parses.
   */
  setSwitch(key: string, on: boolean): void {
    if (!on) {
      this.set(key, false);
      return;
    }
    let object: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(this.text(key) || '{}') as unknown;
      if (isRecord(parsed)) object = parsed;
    } catch {
      // The text is not JSON, so the switch starts from an empty object.
    }
    this.set(key, object);
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
      problemWith(control, this.#drafts.get(key), this.#baseline[key] !== undefined)
    );
  }

  /** The dirty keys, in the schema's order. */
  get dirtyKeys(): readonly string[] {
    return [...this.#controls.keys()].filter((key) => this.isDirty(key));
  }

  /** Whether a change can be sent: something is dirty and nothing dirty has a problem. */
  get canSave(): boolean {
    const dirty = this.dirtyKeys;
    return dirty.length > 0 && dirty.every((key) => this.error(key) === undefined);
  }

  /** The patch an update sends: the dirty keys, each with its draft. */
  patch(): Record<string, unknown> {
    return Object.fromEntries(this.dirtyKeys.map((key) => [key, this.#drafts.get(key)]));
  }

  /** Puts every key back to what the snapshot holds. */
  discard(): void {
    for (const [key, control] of this.#controls) {
      this.#drafts.set(key, this.#baseline[key]);
      if (holdsJson(control)) this.#texts.set(key, textOf(control, this.#baseline[key]));
    }
    this.#parseErrors.clear();
  }
}
