/**
 * The work a rendered A2UI node does outside its markup: resolving dynamic
 * properties in its scope, expanding its children (including templates),
 * evaluating checks, writing bound inputs, and dispatching actions.
 */
import { childPointer, resolvePath } from './data-model.svelte.ts';
import {
  type A2uiEvaluationContext,
  callFunction,
  resolveDynamic,
  stringify,
} from './functions.ts';
import type { A2uiRenderContext } from './render-context.ts';
import type { A2uiComponent, A2uiJsonValue } from './types.ts';

/** One child to render: a component id and the scope its relative paths resolve in. */
export type A2uiChild = { readonly id: string; readonly scope: string; readonly key: string };

/** The evaluation context of a node in `scope`. */
export function evaluationContext(
  context: A2uiRenderContext,
  componentId: string,
  scope: string,
): A2uiEvaluationContext {
  return {
    read: (pointer) => context.model.get(pointer),
    scope,
    locale: context.locale,
    report: (message) => context.report('function-error', componentId, message),
  };
}

/** A dynamic property as text (`''` when absent). */
export function resolveString(value: unknown, evaluation: A2uiEvaluationContext): string {
  return stringify(resolveDynamic(value, evaluation));
}

/** A dynamic property as a number, or `undefined`. */
export function resolveNumber(
  value: unknown,
  evaluation: A2uiEvaluationContext,
): number | undefined {
  const resolved = resolveDynamic(value, evaluation);
  if (typeof resolved === 'number' && Number.isFinite(resolved)) return resolved;
  if (typeof resolved === 'string' && resolved.trim() !== '' && Number.isFinite(Number(resolved))) {
    return Number(resolved);
  }
  return undefined;
}

/** A dynamic property as a boolean (`false` unless it is `true`). */
export function resolveBoolean(value: unknown, evaluation: A2uiEvaluationContext): boolean {
  return resolveDynamic(value, evaluation) === true;
}

/** A dynamic string list (a ChoicePicker's selection). */
export function resolveStringList(value: unknown, evaluation: A2uiEvaluationContext): string[] {
  const resolved = resolveDynamic(value, evaluation);
  if (!Array.isArray(resolved)) return [];
  return resolved.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Where a bound input writes: the pointer of its `{ path }` binding, or
 * `undefined` for a literal, which the input then holds on its own.
 */
export function boundPointer(value: unknown, scope: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const path: unknown = Reflect.get(value, 'path');
  return typeof path === 'string' ? resolvePath(path, scope) : undefined;
}

/**
 * A container's children: a static list of ids in the container's scope, or
 * a template instantiated once per item of the bound array, each in the
 * item's own scope.
 */
export function expandChildren(
  children: unknown,
  scope: string,
  context: A2uiRenderContext,
): A2uiChild[] {
  if (Array.isArray(children)) {
    return children
      .filter((id): id is string => typeof id === 'string')
      .map((id, index) => ({ id, scope, key: `${index}:${id}` }));
  }
  if (typeof children !== 'object' || children === null) return [];
  const template = children as { componentId?: unknown; path?: unknown };
  if (typeof template.componentId !== 'string' || typeof template.path !== 'string') return [];
  const pointer = resolvePath(template.path, scope);
  const items = context.model.get(pointer);
  if (!Array.isArray(items)) return [];
  const componentId = template.componentId;
  return items.map((_item, index) => ({
    id: componentId,
    scope: childPointer(pointer, index),
    key: `${index}:${componentId}`,
  }));
}

/** The message of the first failing check, or `undefined` when every check passes. */
export function failingCheck(
  checks: unknown,
  evaluation: A2uiEvaluationContext,
): string | undefined {
  if (!Array.isArray(checks)) return undefined;
  for (const check of checks) {
    if (typeof check !== 'object' || check === null) continue;
    if (resolveDynamic(Reflect.get(check, 'condition'), evaluation) !== true) {
      return stringify(Reflect.get(check, 'message'));
    }
  }
  return undefined;
}

/**
 * Runs a Button's action: a server event goes to the host with its context
 * resolved now, at the moment of interaction; a function call runs here.
 */
export function runAction(
  action: unknown,
  component: A2uiComponent,
  context: A2uiRenderContext,
  evaluation: A2uiEvaluationContext,
): void {
  if (typeof action !== 'object' || action === null) return;
  const event: unknown = Reflect.get(action, 'event');
  const functionCall: unknown = Reflect.get(action, 'functionCall');
  if (typeof event === 'object' && event !== null) {
    const name: unknown = Reflect.get(event, 'name');
    const raw: unknown = Reflect.get(event, 'context');
    if (typeof name !== 'string') return;
    const resolved: Record<string, A2uiJsonValue> = {};
    if (typeof raw === 'object' && raw !== null) {
      for (const [key, value] of Object.entries(raw)) {
        // A `__proto__` key from the wire would set the context's prototype, not add data.
        if (key !== '__proto__') resolved[key] = toJsonValue(resolveDynamic(value, evaluation));
      }
    }
    context.dispatch({
      name,
      surfaceId: context.surfaceId,
      sourceComponentId: component.id,
      timestamp: new Date().toISOString(),
      context: resolved,
    });
    return;
  }
  if (typeof functionCall === 'object' && functionCall !== null) {
    const call: unknown = Reflect.get(functionCall, 'call');
    if (typeof call === 'string') {
      callFunction(call, Reflect.get(functionCall, 'args'), { ...evaluation, activated: true });
    }
  }
}

/** A resolved value as JSON: anything else (a function, `undefined`) becomes `null`. */
export function toJsonValue(value: unknown): A2uiJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    const result: Record<string, A2uiJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key !== '__proto__') result[key] = toJsonValue(entry);
    }
    return result;
  }
  return null;
}

/**
 * Strips common Markdown markers, for text that renders inline. As in
 * CommonMark, `*` emphasizes inside a word but `_` does not, so `save_file_as`
 * keeps its underscores.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/(?<![\p{L}\p{N}_])__(.+?)__(?![\p{L}\p{N}_])/gu, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/(?<![\p{L}\p{N}_])_(.+?)_(?![\p{L}\p{N}_])/gu, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

/** An element id unique to a node instance (a template repeats component ids). */
export function elementId(
  context: A2uiRenderContext,
  componentId: string,
  scope: string,
  part?: string,
): string {
  // Injective: each segment escapes every character outside [A-Za-z0-9] as `_`,
  // its code point, and `_`, so `-` only ever separates segments, and no part
  // of one component's id equals another component's id.
  const segments = [context.idPrefix, componentId, scope, ...(part === undefined ? [] : [part])];
  return segments
    .map((segment) =>
      segment.replace(
        /[^A-Za-z0-9]/g,
        (character) => `_${character.codePointAt(0)?.toString(16)}_`,
      ),
    )
    .join('-');
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_ONLY = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;

function localParts(date: Date): { date: string; time: string } {
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

/**
 * An ISO 8601 value in the form a Cinder date or time control takes: a date
 * (`YYYY-MM-DD`) for `day`, a local date and time (`YYYY-MM-DDTHH:mm`) for
 * `minute`, a time (`HH:mm`) for `time`. A zoned value is shown in local time.
 * `undefined` when the value has nothing the control can show.
 */
export function dateTimeForControl(
  value: unknown,
  control: 'day' | 'minute' | 'time',
): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  let date: string | undefined;
  let time: string | undefined;
  const dateOnly = DATE_ONLY.exec(value);
  const timeOnly = TIME_ONLY.exec(value);
  const local = LOCAL_DATE_TIME.exec(value);
  if (dateOnly !== null) {
    date = value;
  } else if (timeOnly !== null) {
    time = `${timeOnly[1]}:${timeOnly[2]}`;
  } else if (local !== null) {
    date = local[1];
    time = local[2];
  } else {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return undefined;
    ({ date, time } = localParts(parsed));
  }
  if (control === 'time') return time;
  if (control === 'day') return date;
  return date === undefined ? undefined : `${date}T${time ?? '00:00'}`;
}

/** Whether `value` matches `pattern`, or `undefined` when the pattern is not a valid one. */
export function matchesPattern(pattern: string, value: string): boolean | undefined {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return undefined;
  }
}

/** An A2UI icon name as words: `shoppingCart` → `Shopping cart`. */
export function iconLabel(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
