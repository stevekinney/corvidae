/** One agent as the roster keeps it: plain JSON data, so it can live in `$.state`. */
export type AgentRow = {
  id: string;
  description: string;
  type: string;
  status: string;
  parentId: string | null;
};

declare module 'claude-code' {
  interface PluginState {
    'agent-roster': {
      /** The latest `$.agent.list()` snapshot, tagged so a reload can decline an older shape. */
      agents: Shaped<AgentRow[]>;
      /** One flag per agent id: whether its row shows details. */
      isExpanded: StateFamily<boolean>;
      /** The person's choice to hide the band; mirrored from `$.store`. */
      isBandHidden: boolean;
    };
  }
}
