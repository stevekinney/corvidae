/** One prefix a command palette query can start with, and the scope it narrows the list to. */
export type CommandQueryScope<Scope extends string = string> = {
  /** The leading character or characters that select the scope: `>` for actions, `@` for agents. */
  readonly prefix: string;
  /** The scope the prefix selects, in the page's own vocabulary: `'actions'`, `'agents'`. */
  readonly scope: Scope;
};

/** What a query means once a leading scope prefix has been read. */
export type ParsedCommandQuery<Scope extends string = string> = {
  /** The scope the query's prefix selected, or `undefined` when the query has no prefix. */
  readonly scope: Scope | undefined;
  /** The text to match, without the prefix and with its leading whitespace removed. */
  readonly term: string;
};

/**
 * Reads a leading scope prefix off a command palette query, so `> restart` narrows the list to
 * actions matching "restart" and `@ tool` narrows it to agents matching "tool".
 *
 * The palette hands its query to the page's `items` snippet and leaves filtering to the page; this
 * is the part of that filtering every page would otherwise write for itself. Leading whitespace is
 * ignored, the longest matching prefix wins, and a query with no prefix is returned whole.
 *
 * @example
 * ```ts
 * const scopes = [
 *   { prefix: '>', scope: 'actions' },
 *   { prefix: '@', scope: 'agents' },
 * ] as const;
 * parseCommandQuery('> restart', scopes); // { scope: 'actions', term: 'restart' }
 * parseCommandQuery('home', scopes); // { scope: undefined, term: 'home' }
 * ```
 */
export function parseCommandQuery<Scope extends string>(
  query: string,
  scopes: readonly CommandQueryScope<Scope>[],
): ParsedCommandQuery<Scope> {
  const trimmed = query.trimStart();
  let match: CommandQueryScope<Scope> | undefined;
  for (const candidate of scopes) {
    if (candidate.prefix === '' || !trimmed.startsWith(candidate.prefix)) continue;
    if (match === undefined || candidate.prefix.length > match.prefix.length) match = candidate;
  }
  if (match === undefined) return { scope: undefined, term: query };
  return { scope: match.scope, term: trimmed.slice(match.prefix.length).trimStart() };
}
