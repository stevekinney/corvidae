import { sleepForTesting } from '@lostgradient/testing/fake-timers';
import { describe, expect, it, spyOn } from 'bun:test';

import {
  closeJsonRpcSessionsForShutdown,
  closeJsonRpcWebSocketSession,
  handleJsonRpcWebSocketMessage,
  openGenericJsonRpcWebSocketSession,
  openJsonRpcWebSocketSession,
  type WebSocketData,
} from './json-rpc-websocket-runtime.ts';
import type { JsonRpcWebSocketSession } from './json-rpc-websocket.ts';

function createWebSocket(data: Partial<WebSocketData> = {}): {
  ws: {
    data: WebSocketData;
    send(message: string): number;
    close(code?: number, reason?: string): void;
  };
  sent: string[];
  closeCalls: Array<{ code: number | undefined; reason: string | undefined }>;
} {
  const sent: string[] = [];
  const closeCalls: Array<{ code: number | undefined; reason: string | undefined }> = [];
  return {
    ws: {
      data: {
        pathname: '/jsonrpc',
        connectionType: 'jsonrpc',
        ...data,
      },
      send(message: string) {
        sent.push(message);
        return sent.length;
      },
      close(code?: number, reason?: string) {
        closeCalls.push({ code, reason });
      },
    },
    sent,
    closeCalls,
  };
}

describe('json-rpc websocket runtime helpers', () => {
  it('denies queued operations when workspace removal precedes their admission check', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let member = true;
    const handled: string[] = [];
    const { ws, closeCalls } = createWebSocket({
      revalidateWorkspace: async () => {
        entered.resolve();
        await release.promise;
        return member;
      },
      jsonRpcSession: {
        handleMessage: async (message) => {
          handled.push(message);
        },
        close: async () => {},
      },
    });
    handleJsonRpcWebSocketMessage(ws, 'private-operation');
    await entered.promise;
    handleJsonRpcWebSocketMessage(ws, 'another-operation');
    member = false;
    release.resolve();
    await ws.data.workspaceRequestTail;
    expect(handled).toEqual([]);
    expect(closeCalls).toEqual([{ code: 1008, reason: 'Workspace membership required' }]);
  });

  it('does not admit a pending message after the socket closes during revalidation', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const handled: string[] = [];
    const { ws } = createWebSocket({
      revalidateWorkspace: async () => {
        entered.resolve();
        await release.promise;
        return true;
      },
      jsonRpcSession: {
        handleMessage: async (message) => {
          handled.push(message);
        },
        close: async () => {},
      },
    });
    handleJsonRpcWebSocketMessage(ws, 'private-operation');
    await entered.promise;
    ws.data.workspaceClosed = true;
    release.resolve();
    await ws.data.workspaceRequestTail;
    expect(handled).toEqual([]);
  });

  it('does not hold later admissions behind an already admitted long-running operation', async () => {
    const release = Promise.withResolvers<void>();
    const handled: string[] = [];
    const { ws } = createWebSocket({
      revalidateWorkspace: async () => true,
      jsonRpcSession: {
        handleMessage: async (message) => {
          handled.push(message);
          if (message === 'long-running') await release.promise;
        },
        close: async () => {},
      },
    });
    handleJsonRpcWebSocketMessage(ws, 'long-running');
    handleJsonRpcWebSocketMessage(ws, 'cancel');
    await ws.data.workspaceRequestTail;
    expect(handled).toEqual(['long-running', 'cancel']);
    release.resolve();
  });

  it('closes the socket when an admitted workspace request rejects', async () => {
    const { ws, closeCalls } = createWebSocket({
      revalidateWorkspace: async () => true,
      jsonRpcSession: {
        handleMessage: async () => {
          throw new Error('request failed');
        },
        close: async () => {},
      },
    });

    handleJsonRpcWebSocketMessage(ws, 'private-operation');
    await ws.data.workspaceRequestTail;
    await sleepForTesting(0);

    expect(ws.data.workspaceClosed).toBe(true);
    expect(closeCalls).toEqual([{ code: 1011, reason: 'Workspace request failed' }]);
  });

  it('closes the socket when workspace cleanup rejects during admission failure', async () => {
    const { ws, closeCalls } = createWebSocket({
      revalidateWorkspace: async () => false,
      jsonRpcSession: {
        handleMessage: async () => {},
        close: async () => {
          throw new Error('session cleanup failed');
        },
      },
    });

    handleJsonRpcWebSocketMessage(ws, 'private-operation');
    await ws.data.workspaceRequestTail;

    expect(ws.data.workspaceClosed).toBe(true);
    expect(closeCalls).toEqual([
      { code: 1008, reason: 'Workspace membership required' },
      { code: 1011, reason: 'Workspace request failed' },
    ]);
  });

  it('fails closed when workspace revalidation rejects', async () => {
    const handled: string[] = [];
    const { ws, closeCalls } = createWebSocket({
      revalidateWorkspace: async () => {
        throw new Error('revalidation unavailable');
      },
      jsonRpcSession: {
        handleMessage: async (message) => {
          handled.push(message);
        },
        close: async () => {},
      },
    });

    handleJsonRpcWebSocketMessage(ws, 'private-operation');
    await ws.data.workspaceRequestTail;

    expect(handled).toEqual([]);
    expect(ws.data.workspaceClosed).toBe(true);
    expect(closeCalls).toEqual([{ code: 1008, reason: 'Workspace membership required' }]);
  });

  it('discards an outgoing frame when membership is lost at the release barrier', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let member = true;
    const { ws, sent, closeCalls } = createWebSocket({
      revalidateWorkspace: async () => {
        entered.resolve();
        await release.promise;
        return member;
      },
    });
    const module = await import('./json-rpc-websocket.ts');
    const create = spyOn(module, 'createJsonRpcWebSocketSession').mockImplementation((options) => {
      options.emitter.send('PRIVATE-FRAME');
      return { handleMessage: async () => {}, close: async () => {} };
    });
    try {
      openGenericJsonRpcWebSocketSession({
        ws,
        registry: {} as never,
        host: {},
        activeSessions: new Set(),
      });
      await entered.promise;
      member = false;
      release.resolve();
      await ws.data.workspaceReleaseTail;
      expect(sent).toEqual([]);
      expect(closeCalls).toEqual([{ code: 1008, reason: 'Workspace membership required' }]);
    } finally {
      create.mockRestore();
    }
  });

  it('sends an outgoing frame after the workspace release check succeeds', async () => {
    const { ws, sent } = createWebSocket({ revalidateWorkspace: async () => true });
    const jsonRpcModule = await import('./json-rpc-websocket.ts');
    const create = spyOn(jsonRpcModule, 'createJsonRpcWebSocketSession').mockImplementation(
      (options) => {
        options.emitter.send('PRIVATE-FRAME');
        return { handleMessage: async () => {}, close: async () => {} };
      },
    );

    try {
      openGenericJsonRpcWebSocketSession({
        ws,
        registry: {} as never,
        host: {},
        activeSessions: new Set(),
      });
      await ws.data.workspaceReleaseTail;

      expect(sent).toEqual(['PRIVATE-FRAME']);
    } finally {
      create.mockRestore();
    }
  });

  it('closes the socket when an outgoing frame release fails', async () => {
    const { ws, closeCalls } = createWebSocket({ revalidateWorkspace: async () => true });
    const jsonRpcModule = await import('./json-rpc-websocket.ts');
    const create = spyOn(jsonRpcModule, 'createJsonRpcWebSocketSession').mockImplementation(
      (options) => {
        options.emitter.send('PRIVATE-FRAME');
        return { handleMessage: async () => {}, close: async () => {} };
      },
    );
    ws.send = () => {
      throw new Error('socket closed');
    };

    try {
      openGenericJsonRpcWebSocketSession({
        ws,
        registry: {} as never,
        host: {},
        activeSessions: new Set(),
      });
      await ws.data.workspaceReleaseTail;

      expect(ws.data.workspaceClosed).toBe(true);
      expect(closeCalls).toEqual([{ code: 1011, reason: 'Workspace stream closed' }]);
    } finally {
      create.mockRestore();
    }
  });
  it('closes frames that arrive without a session attached', () => {
    const { ws, closeCalls } = createWebSocket();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      handleJsonRpcWebSocketMessage(ws, '{"jsonrpc":"2.0"}');

      expect(closeCalls).toEqual([{ code: 1011, reason: 'no jsonrpc session attached' }]);
      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] /jsonrpc WS frame received with no session attached — closing',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('decodes Buffer frames and logs rejected message handlers', async () => {
    const closeCalls: Array<{ code: number | undefined; reason: string | undefined }> = [];
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const session = {
      handleMessage: async (frame: string) => {
        expect(frame).toBe('{"jsonrpc":"2.0"}');
        throw new Error('frame failed');
      },
      async close() {},
    } satisfies JsonRpcWebSocketSession;

    try {
      handleJsonRpcWebSocketMessage(
        {
          data: {
            pathname: '/jsonrpc',
            connectionType: 'jsonrpc',
            jsonRpcSession: session,
          },
          close(code?: number, reason?: string) {
            closeCalls.push({ code, reason });
          },
        },
        Buffer.from('{"jsonrpc":"2.0"}'),
      );
      await sleepForTesting(0);

      expect(closeCalls).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith('[weft] /jsonrpc WS message error', expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('attaches a session, uses the websocket emitter, and tracks the active session', async () => {
    const { ws, sent } = createWebSocket();
    const activeSessions = new Set<JsonRpcWebSocketSession>();
    const jsonRpcModule = await import('./json-rpc-websocket.ts');
    const session: JsonRpcWebSocketSession = {
      async handleMessage() {},
      async close() {},
    };
    const createJsonRpcWebSocketSessionSpy = spyOn(
      jsonRpcModule,
      'createJsonRpcWebSocketSession',
    ).mockImplementation((options) => {
      options.emitter.send('server-message');
      expect(options.transport).toBe('jsonRpcWebSocket');
      return session;
    });

    try {
      openJsonRpcWebSocketSession({
        ws,
        registry: {} as never,
        engine: {},
        feed: {} as never,
        fleetFeed: {} as never,
        activeSessions,
      });

      expect(ws.data.jsonRpcSession).toBe(session);
      expect(activeSessions.has(session)).toBe(true);
      expect(sent).toEqual(['server-message']);
    } finally {
      createJsonRpcWebSocketSessionSpy.mockRestore();
    }
  });

  it('logs and closes the socket when session construction throws', async () => {
    const { ws, closeCalls } = createWebSocket();
    const activeSessions = new Set<JsonRpcWebSocketSession>();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const jsonRpcModule = await import('./json-rpc-websocket.ts');
    const createJsonRpcWebSocketSessionSpy = spyOn(
      jsonRpcModule,
      'createJsonRpcWebSocketSession',
    ).mockImplementation(() => {
      throw new Error('session construction failed');
    });

    try {
      openJsonRpcWebSocketSession({
        ws,
        registry: {} as never,
        engine: {},
        feed: {} as never,
        fleetFeed: {} as never,
        activeSessions,
      });

      expect(closeCalls).toEqual([{ code: 1011, reason: 'session construction failed' }]);
      expect(activeSessions.size).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] /jsonrpc WS session construction failed',
        expect.any(Error),
      );
    } finally {
      createJsonRpcWebSocketSessionSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('logs and closes a generic socket when session construction throws', async () => {
    const { ws, closeCalls } = createWebSocket();
    const activeSessions = new Set<JsonRpcWebSocketSession>();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const jsonRpcModule = await import('./json-rpc-websocket.ts');
    const createJsonRpcWebSocketSessionSpy = spyOn(
      jsonRpcModule,
      'createJsonRpcWebSocketSession',
    ).mockImplementation(() => {
      throw new Error('generic session construction failed');
    });

    try {
      openGenericJsonRpcWebSocketSession({
        ws,
        registry: {} as never,
        host: {},
        activeSessions,
      });

      expect(closeCalls).toEqual([{ code: 1011, reason: 'session construction failed' }]);
      expect(ws.data.jsonRpcSession).toBeUndefined();
      expect(activeSessions.size).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] generic JSON-RPC WS session construction failed',
        expect.any(Error),
      );
    } finally {
      createJsonRpcWebSocketSessionSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('logs rejected close handlers and removes the closed session from the active set', async () => {
    const closeFailure = new Error('close failed');
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const session: JsonRpcWebSocketSession = {
      async handleMessage() {},
      async close() {
        throw closeFailure;
      },
    };
    const activeSessions = new Set<JsonRpcWebSocketSession>([session]);

    try {
      closeJsonRpcWebSocketSession({ session, activeSessions });
      await sleepForTesting(0);

      expect(activeSessions.size).toBe(0);
      expect(errorSpy).toHaveBeenCalledWith('[weft] /jsonrpc WS session close error', closeFailure);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs rejected shutdown closes for every active session and clears the active set', async () => {
    const closeFailure = new Error('shutdown close failed');
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const activeSessions = new Set<JsonRpcWebSocketSession>([
      {
        async handleMessage() {},
        async close() {
          throw closeFailure;
        },
      },
      {
        async handleMessage() {},
        async close() {
          throw closeFailure;
        },
      },
    ]);

    try {
      await closeJsonRpcSessionsForShutdown(activeSessions);

      expect(activeSessions.size).toBe(0);
      expect(errorSpy).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledWith(
        '[weft] /jsonrpc WS session close error during shutdown',
        closeFailure,
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
