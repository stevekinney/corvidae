/**
 * COR-1871 — identifiers a plugin contributes. An agent or workflow a plugin ships is named
 * `plugin:name`, the form armorer gives a tool id. An owner's file stem never has a colon, so an
 * owner file cannot claim a plugin's namespace.
 *
 * Weft's name grammar is unchanged and has no `:`. A `plugin:name` reaches Weft as `plugin__name`:
 * a handler a workflow document names, and the workflow type of a plugin's workflow file. Neither
 * segment may contain `_`, so `__` occurs exactly once in the image and the mapping is injective. A
 * bare handler name that contained `__` could equal an image, so Bureau refuses it; an owner's
 * workflow file stem cannot contain `_` at all.
 */

/** A segment of a namespaced identifier: a letter first, so the mapped handler name passes Weft's grammar. */
export const IDENTIFIER_SEGMENT_SOURCE = '[a-z](?:[a-z0-9-]*[a-z0-9])?';

/**
 * The namespaces a plugin may not take, because an id beginning with one is already something
 * else: a tried agent (`try:`), or an owner that durable event history or the audit trail records
 * under `<prefix>:<id>`.
 */
export const RESERVED_NAMESPACES: readonly string[] = [
  'try',
  'agent',
  'run',
  'session',
  'schedule',
  'workflow',
  'goal',
  'worker-deployment',
  'skill-source',
  'tool-source',
  'hook',
  'bureau-goal-audit',
];

/** The source of the namespaced grammar, without anchors, for patterns that also accept a bare id. */
export const NAMESPACED_IDENTIFIER_SOURCE = `(?!(?:${RESERVED_NAMESPACES.join('|')}):)${IDENTIFIER_SEGMENT_SOURCE}:${IDENTIFIER_SEGMENT_SOURCE}`;

/** What a `plugin:name` identifier looks like: two segments around one colon. */
export const NAMESPACED_IDENTIFIER_PATTERN = new RegExp(`^${NAMESPACED_IDENTIFIER_SOURCE}$`);

/** The separator Weft's name grammar can carry in place of the colon. */
const HANDLER_SEPARATOR = '__';

/** Whether `id` is a `plugin:name` identifier. */
export function isNamespacedIdentifier(id: string): boolean {
  return NAMESPACED_IDENTIFIER_PATTERN.test(id);
}

/** The Weft name of the namespaced `id` (`linear:sync-issue` → `linear__sync-issue`). */
export function toWeftName(id: string): string {
  if (!isNamespacedIdentifier(id)) {
    throw new TypeError(`"${id}" is not a plugin:name identifier.`);
  }
  return id.replace(':', HANDLER_SEPARATOR);
}

/**
 * The namespaced identifier a Weft handler or workflow name stands for, or `undefined` when `name`
 * is not the image of one.
 */
export function fromWeftName(name: string): string | undefined {
  const index = name.indexOf(HANDLER_SEPARATOR);
  if (index === -1 || index !== name.lastIndexOf(HANDLER_SEPARATOR)) return undefined;
  const id = `${name.slice(0, index)}:${name.slice(index + HANDLER_SEPARATOR.length)}`;
  return isNamespacedIdentifier(id) ? id : undefined;
}

/** Whether `name` is a Weft handler or workflow name that stands for a namespaced identifier. */
export function isMappedWeftName(name: string): boolean {
  return fromWeftName(name) !== undefined;
}

/**
 * Why `handler`, as a document names it, cannot be a handler; `undefined` when it can. A namespaced
 * name is fine; a bare name must not contain `__`, which would make it look like a mapped one.
 */
export function handlerNameIssue(handler: string): string | undefined {
  if (isNamespacedIdentifier(handler)) return undefined;
  return handler.includes(HANDLER_SEPARATOR)
    ? `handler "${handler}" contains "__", which Bureau reserves for the plugin:name mapping; rename it or use a plugin:name handler`
    : undefined;
}

/**
 * The name a handler or workflow identifier carries to Weft: mapped when namespaced, as written
 * otherwise. A name already in Weft's form is returned unchanged.
 */
export function weftNameOf(name: string): string {
  return isNamespacedIdentifier(name) ? toWeftName(name) : name;
}

/**
 * The identifier Bureau knows a Weft handler or workflow name by: the namespaced identifier a
 * mapped name stands for, and any other name as it is. A name already in Bureau's form is returned
 * unchanged, so applying it twice is harmless.
 */
export function bureauNameOf(name: string): string {
  return fromWeftName(name) ?? name;
}
