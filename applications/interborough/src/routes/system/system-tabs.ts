/**
 * The tabs the System page held, by their `?tab=` value, and the words that name each one. The
 * page was split by audience, so each of Health and Settings › API reference lists the subset it
 * carries (`HEALTH_TABS`, `API_REFERENCE_TABS`); no other page renders one.
 */

/** Every tab's `?tab=` value, with the words that name it. */
export const SYSTEM_TABS = {
  registry: 'Workflow types',
  realms: 'Realms',
  metrics: 'Metrics',
  discovery: 'Discovery',
  operations: 'Operations',
  health: 'Health',
  alerts: 'Alerts',
  scopes: 'Scopes',
} as const;

export type SystemTabValue = keyof typeof SYSTEM_TABS;

/** The tabs Settings › API reference carries: what the engine exposes, and what the caller may do. */
export const API_REFERENCE_TABS: readonly SystemTabValue[] = [
  'registry',
  'discovery',
  'operations',
  'scopes',
];

/** The tabs Health carries below the overview, without Realms, which only an engine running realms has. */
export const HEALTH_TABS: readonly SystemTabValue[] = ['metrics', 'alerts', 'health'];

/** The tabs Health carries for an engine that runs realms. */
export const HEALTH_TABS_WITH_REALMS: readonly SystemTabValue[] = [...HEALTH_TABS, 'realms'];
