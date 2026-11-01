/**
 * The sixth end-to-end host (`E2E_CONNECT_PORT`), the one whose restart is real. The production
 * entry (`src/host/serve.ts`) runs as a child of the real supervisor (`src/host/supervisor.ts
 * serve`), exactly as `bun run start` does, so `POST /host/restart` stops it with exit code 75 and
 * the supervisor starts it again, with the same home. The main host cannot do this: its console
 * engine is created in the process, so a restart would lose every fixture the other specifications
 * read.
 *
 * It also starts the servers the connect specification points the dialog at, on loopback ports:
 *
 * - an MCP server that answers only the bearer token `E2E_CONNECT_TOKEN`;
 * - an MCP server behind a mock OAuth authorization server, which approves at once;
 * - an OpenAPI service whose document is served at `/openapi.json`.
 *
 * Their origins are served to the specification by `e2e-server.ts` (loopback addresses, no secret).
 * Nothing leaves the machine, and every token the servers issue is made up.
 */
import { join } from 'node:path';

import {
  petsDocument,
  startMcpServer,
  startOAuthMcpServer,
  type OAuthMcpServer,
  type TestServer,
} from '../../src/host/tool-source-servers.test-support.ts';
import { E2E_CONNECT_TOKEN } from './e2e-constants.ts';

/** The addresses of the servers the connect specification connects to. */
export type ConnectOrigins = {
  /** The MCP server that needs `E2E_CONNECT_TOKEN`. */
  readonly bearerMcp: string;
  /** The MCP server behind the mock OAuth authorization server. */
  readonly oauthMcp: string;
  /** The OpenAPI service; its document is at `<origin>/openapi.json`. */
  readonly pets: string;
};

/** The connect host, and how to stop it and its servers. */
export type ConnectHost = {
  readonly origins: ConnectOrigins;
  /** The process id of the supervisor, which a specification never needs but a test of the harness does. */
  readonly supervisorPid: number;
  stop(): Promise<void>;
};

/** What starting the connect host reads. */
export type ConnectHostOptions = {
  /** The directory the host keeps its state in; it is created by the caller and starts empty. */
  readonly home: string;
  /** The built application the host serves. */
  readonly buildDirectory: string;
  readonly port: number;
};

const SUPERVISOR = join(import.meta.dir, '..', '..', 'src', 'host', 'supervisor.ts');
const LISTENING = /Interborough is listening on/;

async function startPetsService(): Promise<TestServer> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === '/openapi.json'
        ? Response.json(petsDocument)
        : Response.json({ ok: true }),
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    authorizations: [],
    stop: () => server.stop(true),
  };
}

/**
 * Copies the supervisor's output to this process's, and resolves once the host has said it is
 * listening. It keeps copying afterwards, because the supervisor writes the host's output to the
 * same pipe each time it starts the host again, and a pipe nobody reads fills up and stops it.
 */
function watchOutput(stream: ReadableStream<Uint8Array>): { listening: Promise<void> } {
  const decoder = new TextDecoder();
  let seen = '';
  let heard: () => void = () => undefined;
  const listening = new Promise<void>((resolve) => {
    heard = resolve;
  });
  void (async () => {
    for await (const chunk of stream) {
      process.stdout.write(chunk);
      if (seen.length < 4096) {
        seen += decoder.decode(chunk, { stream: true });
        if (LISTENING.test(seen)) heard();
      }
    }
  })();
  return { listening };
}

/** Starts the servers, then the host under the supervisor, and resolves once the host is listening. */
export async function startConnectHost(options: ConnectHostOptions): Promise<ConnectHost> {
  const bearer = await startMcpServer(E2E_CONNECT_TOKEN);
  const oauth: OAuthMcpServer = await startOAuthMcpServer();
  const pets = await startPetsService();
  const supervisor = Bun.spawn([process.execPath, '--no-install', SUPERVISOR, 'serve'], {
    env: {
      ...process.env,
      INTERBOROUGH_HOME: options.home,
      INTERBOROUGH_PORT: String(options.port),
      INTERBOROUGH_BUILD_DIRECTORY: options.buildDirectory,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const { listening } = watchOutput(supervisor.stdout);
  await Promise.race([
    listening,
    supervisor.exited.then((code) => {
      throw new Error(
        `The connect host's supervisor exited with ${String(code)} before it listened.`,
      );
    }),
  ]);
  return {
    origins: { bearerMcp: bearer.origin, oauthMcp: oauth.origin, pets: pets.origin },
    supervisorPid: supervisor.pid,
    stop: async () => {
      // The supervisor forwards the signal to the host and ends once it has gone.
      supervisor.kill('SIGTERM');
      await supervisor.exited;
      await Promise.all([bearer.stop(), oauth.stop(), pets.stop()]);
    },
  };
}
