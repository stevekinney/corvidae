/**
 * The paths that name a thing by its identifier, for the identifiers a path cannot carry. A browser
 * resolves `.` and `..` out of a path before the client router can read them, and a chat session
 * named `new` is the static `/chats/new` route's. The path builders put such an identifier in the
 * query, under a placeholder segment, and the router puts it back (`router.svelte.ts`'s `current`).
 *
 * This module imports nothing of the router, so a route's own loader can build a path.
 */

/** The path segment the path builders emit in place of an identifier that cannot be a path segment. */
export const ESCAPED_ID_PLACEHOLDER = '_';

function isDotOnly(id: string): boolean {
  return id === '.' || id === '..';
}

/**
 * The identifiers a route's path cannot carry, by route pattern: the path parameter that holds the
 * placeholder, the query key that holds the identifier, and which identifiers are escaped.
 */
const ESCAPED_IDENTIFIERS: Readonly<
  Record<
    string,
    {
      readonly parameter: string;
      readonly queryKey: string;
      readonly escapes: (id: string) => boolean;
    }
  >
> = {
  '/runs/:run': { parameter: 'run', queryKey: '__weft_workflow_id', escapes: isDotOnly },
  '/workflows/:workflow/runs/:run': {
    parameter: 'run',
    queryKey: '__weft_workflow_id',
    escapes: isDotOnly,
  },
  '/schedules/:schedule': {
    parameter: 'schedule',
    queryKey: '__weft_schedule_id',
    escapes: isDotOnly,
  },
  '/schedules/:schedule/edit': {
    parameter: 'schedule',
    queryKey: '__weft_schedule_id',
    escapes: isDotOnly,
  },
  // A goal named `new` would be the new goal page's.
  '/goals/:goal': {
    parameter: 'goal',
    queryKey: '__weft_goal_id',
    escapes: (id) => isDotOnly(id) || id === 'new',
  },
  // A hook named `new` would be the new hook page's.
  '/hooks/:hook': {
    parameter: 'hook',
    queryKey: '__weft_hook_id',
    escapes: (id) => isDotOnly(id) || id === 'new',
  },
  '/chats/:chat': {
    parameter: 'chat',
    queryKey: '__weft_session_id',
    escapes: (id) => isDotOnly(id) || id === 'new',
  },
};

/** `/<segment>/<id>`, with an `id` its route cannot carry put in the query, which no browser normalises away. */
export function identifierPath(
  segment: string,
  pattern: string,
  id: string,
  search: URLSearchParams,
): string {
  const escape = ESCAPED_IDENTIFIERS[pattern];
  const escaped = escape?.escapes(id) === true;
  const nextSearch = new URLSearchParams(search);
  if (escape !== undefined && escaped) nextSearch.set(escape.queryKey, id);
  const query = nextSearch.toString();
  return `/${segment}/${escaped ? ESCAPED_ID_PLACEHOLDER : encodeURIComponent(id)}${query ? `?${query}` : ''}`;
}

/**
 * A chat session's page. The session `new` would be the new chat's page, and a dot-only identifier
 * would be resolved away by the browser, so both are carried in the query. Every other identifier
 * is the path segment itself.
 */
export function chatSessionPath(
  sessionId: string,
  search: URLSearchParams = new URLSearchParams(),
): string {
  return identifierPath('chats', '/chats/:chat', sessionId, search);
}

/**
 * A goal's page. The goal `new` would be the new goal page, and a dot-only identifier would be
 * resolved away by the browser, so both are carried in the query.
 */
export function goalPath(
  goalRunId: string,
  search: URLSearchParams = new URLSearchParams(),
): string {
  return identifierPath('goals', '/goals/:goal', goalRunId, search);
}

/**
 * A hook's page. The hook `new` would be the new hook page, and a dot-only identifier would be
 * resolved away by the browser, so both are carried in the query.
 */
export function hookPath(hookId: string, search: URLSearchParams = new URLSearchParams()): string {
  return identifierPath('hooks', '/hooks/:hook', hookId, search);
}

/**
 * The params of a matched route, with the identifier its path stands in for put back. The override
 * stands in for an identifier that cannot be a path segment, and the path builders pair it with the
 * placeholder `_`. On any other path it would make the page act on a different thing than the one
 * its address names.
 */
export function withEscapedIdentifier(
  found: {
    readonly definition: { readonly pattern: string };
    readonly params: Record<string, string>;
  },
  search: URLSearchParams,
): Record<string, string> {
  const escape = ESCAPED_IDENTIFIERS[found.definition.pattern];
  if (escape === undefined || found.params[escape.parameter] !== ESCAPED_ID_PLACEHOLDER) {
    return found.params;
  }
  const identifier = search.get(escape.queryKey);
  return identifier !== null && escape.escapes(identifier)
    ? { ...found.params, [escape.parameter]: identifier }
    : found.params;
}
