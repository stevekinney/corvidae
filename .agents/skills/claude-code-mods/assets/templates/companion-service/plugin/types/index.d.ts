/** One queue item as the mod keeps it in `$.state`: a local view of the service's record. */
export type AttentionItemState = {
  id: string;
  kind: string;
  title: string;
  source: string;
  createdAt: number;
  acknowledgedAt: number | null;
};

/** What the mod knows about its connection to the service right now. */
export type ConnectionState =
  | { kind: 'connecting' }
  | { kind: 'connected'; checkedAt: number }
  | { kind: 'not-running'; retryInMs: number }
  | { kind: 'unreachable'; retryInMs: number }
  | { kind: 'unauthorized'; retryInMs: number }
  | { kind: 'incompatible'; detail: string; retryInMs: number };

declare module 'claude-code' {
  interface PluginState {
    'attention-queue': {
      items: Shaped<AttentionItemState[]>;
      connection: ConnectionState;
    };
  }
}
