import { Electroview } from 'electrobun/view';

import { applicationRequestNames } from '../shared/rpc-request-names';

import type {
  ApplicationBunRequestClient,
  ApplicationRendererRpc,
  ApplicationRPCSchema,
  ChatStreamEndMessage,
  ChatStreamLineMessage,
} from '../shared/rpc-contract';

export type ChatStreamSubscribers = {
  onLine: (payload: ChatStreamLineMessage) => void;
  onEnd: (payload: ChatStreamEndMessage) => void;
};

export type RendererConnection = {
  rpc: ApplicationRendererRpc;
  /**
   * Adds one turn's frame listeners and returns an unsubscribe.
   *
   * Fanned out from a single pair of RPC message handlers rather than
   * registering new ones per turn, because `defineRPC` takes its handler map
   * once at construction — there is no later `addMessageListener` on the
   * object it returns for this contract.
   */
  subscribeToChatStream: (subscribers: ChatStreamSubscribers) => () => void;
};

/**
 * Connects a renderer to Electrobun's native RPC transport.
 *
 * When the view is loaded outside Electrobun — `bun run preview`, `bun run
 * dev:renderer`, or a Playwright browser — there is no native bridge, so every
 * request rejects with an actionable message instead of failing as an opaque
 * `undefined is not a function`.
 */
export function connectRendererRpc(): RendererConnection {
  const subscribers = new Set<ChatStreamSubscribers>();

  const subscribeToChatStream = (entry: ChatStreamSubscribers) => {
    subscribers.add(entry);
    return () => subscribers.delete(entry);
  };

  const nativeRpc = Electroview.defineRPC<ApplicationRPCSchema>({
    handlers: {
      requests: {},
      messages: {
        // Copied before iteration: a listener that unsubscribes itself while
        // the set is being walked would otherwise skip the next one.
        chatStreamLine: (payload) => {
          for (const entry of Array.from(subscribers)) entry.onLine(payload);
        },
        chatStreamEnd: (payload) => {
          for (const entry of Array.from(subscribers)) entry.onEnd(payload);
        },
      },
    },
  });

  // Bracket access because `__electrobun` is Electrobun's own global, injected
  // into the page by the native host rather than declared by this application.
  if (window['__electrobun']) {
    // Constructing the view is what binds `nativeRpc` to the native transport;
    // the instance itself is never needed again.
    const view = new Electroview({ rpc: nativeRpc });
    void view;
    return { rpc: nativeRpc, subscribeToChatStream };
  }

  /*
   * Only contract requests are intercepted. Answering every property access
   * with a function would make this object look like a thenable, so mistakenly
   * `await`ing the client itself would find a `then` and invoke it.
   */
  const unavailableRequestClient = new Proxy({} as ApplicationBunRequestClient, {
    get: (_target, requestName) =>
      typeof requestName === 'string' &&
      applicationRequestNames.includes(requestName as (typeof applicationRequestNames)[number])
        ? () =>
            Promise.reject(
              new Error(`Native RPC request "${requestName}" is unavailable in a browser preview.`),
            )
        : undefined,
  });

  return { rpc: { request: unavailableRequestClient }, subscribeToChatStream };
}
