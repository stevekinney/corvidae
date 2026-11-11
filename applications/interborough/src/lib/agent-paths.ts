/**
 * The addresses of an agent: its page and each of its tabs, its editor, and its memory. This is the
 * one module that spells them, so a link to an agent from the agent list, a schedule, or a goal
 * cannot disagree about how a name is encoded (`app/routes.test.ts` fails if another file builds one).
 */

/**
 * The tabs of an agent's page, in the order the tab bar shows them. Each is a path of its own under
 * the agent (`/agents/<name>/access`), except Chats, which is the agent's own address.
 */
export const AGENT_TABS = [
  'chats',
  'instructions',
  'access',
  'hooks',
  'memory',
  'settings',
] as const;

/** One tab of an agent's page. */
export type AgentTab = (typeof AGENT_TABS)[number];

/** Whether `value` names a tab of an agent's page. */
export function isAgentTab(value: string): value is AgentTab {
  return AGENT_TABS.some((tab) => tab === value);
}

/** An agent's page, which opens on its Chats tab. */
export function agentPath(name: string): string {
  return `/agents/${encodeURIComponent(name)}`;
}

/** One tab of an agent's page: Chats is the page's own address, and every other tab is nested under it. */
export function agentTabPath(name: string, tab: AgentTab): string {
  return tab === 'chats' ? agentPath(name) : `${agentPath(name)}/${tab}`;
}

/** An agent's editor. */
export function agentEditPath(name: string): string {
  return `${agentPath(name)}/edit`;
}

/** The form for a new agent filled from the agent `name`: Duplicate. */
export function agentDuplicatePath(name: string): string {
  return `/agents/new?from=${encodeURIComponent(name)}`;
}

/**
 * What an agent remembers: its page's Memory tab, with the memory `selected` open beside the list
 * when one is named. The open memory is in the query (`?selected=`), so choosing one replaces the
 * address in place and the tab stays mounted.
 */
export function agentMemoryPath(name: string, selected?: string): string {
  const tab = agentTabPath(name, 'memory');
  return selected === undefined ? tab : `${tab}?${new URLSearchParams({ selected }).toString()}`;
}

/**
 * The plugin that ships the agent `name`, or `null` for an owner's agent or one defined in code.
 * A plugin's agent is `plugin:name` (COR-1873), and an owner's file name never has a colon, so the
 * colon tells them apart the way the Bureau does.
 */
export function pluginOfAgent(name: string): string | null {
  const colon = name.indexOf(':');
  return colon === -1 ? null : name.slice(0, colon);
}
