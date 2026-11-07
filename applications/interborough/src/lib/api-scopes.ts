/**
 * The scopes of Interborough's own HTTP API (board PageSettingsSections, "API reference · Your
 * scopes"): what a session may do through the `/api` operations the host serves over Bureau
 * (`src/host/api-routes.ts`). They are Interborough's vocabulary, not Weft's: Weft's engine
 * operations under `/api/v1` keep their own scopes (`scopes.svelte.ts`). Interborough is
 * single-user for now, so the session at the keyboard holds all ten.
 *
 * The host enforces them, on the `/api` operations and on the Bureau operations and settings routes
 * Interborough's own pages call (`src/host/scope-gate.ts`), and the Settings page lists them, so
 * both read this one browser-safe catalog, in the order the board lists it.
 */

/** Every scope of Interborough's API, in the order Settings › API reference lists them. */
export const API_SCOPES = [
  'runs:read',
  'runs:write',
  'chats:write',
  'reviews:write',
  'agents:read',
  'schedules:read',
  'schedules:write',
  'agents:write',
  'hooks:write',
  'settings:write',
] as const;

/** One scope of Interborough's API. */
export type ApiScope = (typeof API_SCOPES)[number];

/** One scope and what it lets a session do. */
export interface ApiScopeEntry {
  /** The scope's name, as an operation and a session name it. */
  readonly scope: ApiScope;
  /** What holding the scope lets a session do, in a few words. */
  readonly description: string;
}

/** Every scope with what it lets a session do, in {@link API_SCOPES} order. */
export const API_SCOPE_CATALOG: readonly ApiScopeEntry[] = [
  { scope: 'runs:read', description: 'See runs and their steps' },
  { scope: 'runs:write', description: 'Start, cancel and retry runs' },
  { scope: 'chats:write', description: 'Send messages' },
  { scope: 'reviews:write', description: 'Approve or deny reviews' },
  { scope: 'agents:read', description: 'See agents' },
  { scope: 'schedules:read', description: 'See schedules' },
  { scope: 'schedules:write', description: 'Create, edit, skip and delete schedules' },
  { scope: 'agents:write', description: 'Create and edit agents' },
  { scope: 'hooks:write', description: 'Create, edit and delete hooks' },
  { scope: 'settings:write', description: 'Change settings and manage plugins' },
];

const KNOWN: ReadonlySet<string> = new Set(API_SCOPES);

/** Whether `value` names one of Interborough's API scopes. */
export function isApiScope(value: string): value is ApiScope {
  return KNOWN.has(value);
}
