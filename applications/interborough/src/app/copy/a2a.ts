/** The numbers a sentence about the agents says in words; a larger count says its digits. */
const COUNT_WORDS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
] as const;

/**
 * The words of Settings › A2A (board PageSettingsSections, "A2A, /settings/a2a" and "A2A with
 * Accept A2A calls off"): the switch that accepts remote calls, the address of the agent card, the
 * agents that answer, push notifications, and the calls that were made. The rows save as they are
 * left, like the rest of Settings.
 */
export const A2A_COPY = {
  intro:
    'Let other agents and tools call yours over the Agent2Agent protocol. Settings save as you leave a field.',
  heading: 'Agent2Agent',
  enabled: {
    label: 'Accept A2A calls',
    description: 'Let other agents and tools call your agents over the Agent2Agent protocol.',
    /** Said under the switch while it is off and nothing waits for a restart. */
    off: 'Off. No remote call is answered. Turning it on applies after a restart.',
  },
  cardUrl: {
    label: 'Agent card URL',
    description: 'Share this address with a caller so it can discover which agents you offer.',
    copy: 'Copy the agent card URL',
    copied: 'Copied',
    unavailable: 'Not known yet',
  },
  agents: {
    label: 'Shared agents',
    /** The row's words: how many agents it lists, and where else the same choice is made. */
    description: (count: number): string => {
      const listed =
        count === 0
          ? 'Agents you add are listed here'
          : count === 1
            ? 'The one agent is listed'
            : `All ${COUNT_WORDS[count] ?? String(count)} agents are listed`;
      return `${listed}; only the ones you turn on here answer remote calls. You can also set this on each agent’s Settings tab.`;
    },
    listLabel: 'Agents that answer remote calls',
    loading: 'Loading the agents',
    loadFailed: 'The agents could not be listed.',
    retry: 'Try again',
    none: 'No agents yet.',
  },
  pushNotifications: {
    label: 'Push notifications',
    description: 'Let a remote caller register a webhook to be told when its task finishes.',
  },
  /** The line under the rows while Accept A2A calls is off. */
  readOnly: 'Agent card URL, Shared agents and Push notifications are read-only while this is off.',
  recent: {
    heading: 'Recent calls',
    empty: {
      title: 'No remote calls yet',
      description:
        'When another agent or tool calls yours, each call appears here with who made it and which agent answered.',
    },
    /** Who made a call: the name the caller gave itself, else its principal, else nothing to name. */
    caller: (call: {
      readonly callerName: string | undefined;
      readonly principal: string | undefined;
    }): string => {
      const name = call.callerName ?? call.principal;
      return name === undefined ? 'Remote agent' : `Remote agent “${name}”`;
    },
    /** Which agent answered, named as the Agents list names it. */
    answeredBy: (agent: string): string => `answered by ${agent}`,
    loading: 'Loading the recent calls',
    loadFailed: {
      title: 'The recent calls could not be loaded',
      description: 'The host did not answer. Check that it is running, then try again.',
    },
    retry: 'Try again',
  },
} as const;
