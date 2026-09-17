import type { ServerWebSocket } from 'bun';
import { createConnection, type Socket } from 'node:net';

/** Carry the real Neon driver's PostgreSQL wire bytes to the local test cluster. */
export function createNeonTestProxy(postgresPort: number): {
  address: string;
  [Symbol.asyncDispose](): Promise<void>;
} {
  const connections = new Set<ServerWebSocket<{ socket: Socket }>>();
  const server = Bun.serve<{ socket: Socket }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, instance) {
      const socket = createConnection({ host: '127.0.0.1', port: postgresPort });
      if (instance.upgrade(request, { data: { socket } })) return undefined;
      socket.destroy();
      return new Response('WebSocket connection required', { status: 400 });
    },
    websocket: {
      open(connection) {
        connections.add(connection);
        const { socket } = connection.data;
        socket.on('data', (bytes) => connection.send(bytes));
        socket.on('error', (error) => connection.close(1011, error.message));
        socket.on('close', () => connection.close());
      },
      message(connection, message) {
        connection.data.socket.write(message);
      },
      close(connection) {
        connections.delete(connection);
        connection.data.socket.destroy();
      },
    },
  });
  return {
    address: `127.0.0.1:${server.port}`,
    async [Symbol.asyncDispose]() {
      for (const connection of connections) {
        connection.data.socket.destroy();
        connection.close();
      }
      await server.stop(true);
    },
  };
}
