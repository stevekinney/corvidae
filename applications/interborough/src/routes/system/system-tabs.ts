/**
 * The tabs Health carries below its overview, by their `?tab=` value, and the words that name each
 * one. The System page was split by audience: Health carries these, and Settings › API reference
 * (`routes/settings/api-reference.svelte`) carries the operations, discovery documents, scopes and
 * workflow sources as a side list of groups, not tabs.
 */

/** Every tab's `?tab=` value, with the words that name it. */
export const SYSTEM_TABS = {
  realms: 'Realms',
  metrics: 'Metrics',
  health: 'Health',
  alerts: 'Alerts',
} as const;

export type SystemTabValue = keyof typeof SYSTEM_TABS;

/** The tabs Health carries below the overview, without Realms, which only an engine running realms has. */
export const HEALTH_TABS: readonly SystemTabValue[] = ['metrics', 'alerts', 'health'];

/** The tabs Health carries for an engine that runs realms. */
export const HEALTH_TABS_WITH_REALMS: readonly SystemTabValue[] = [...HEALTH_TABS, 'realms'];
