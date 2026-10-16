/**
 * Where the Playwright checks find the example: three free loopback ports and a start token, chosen
 * once when the configuration first loads and handed to the server command, the workers and the
 * specs through the environment. Choosing at load keeps concurrent runs on one host from colliding
 * on a port, and the token keeps a run's server from admitting anything that was not started by it.
 *
 * Every worker evaluates the configuration again, so a value already in the environment wins:
 * the first evaluation decides and the rest read what it set.
 */
export type ExampleEnvironment = {
  /** The port the checks' server listens on. */
  readonly port: number;
  /** A port for the checks that start a server of their own. */
  readonly ownServerPort: number;
  /** A port the non-loopback refusal is asked to bind, which it never does. */
  readonly refusalPort: number;
  readonly startToken: string;
};

function freePorts(count: number): number[] {
  // Hold every probe open until all are chosen, so the same port is not handed out twice.
  const probes = Array.from({ length: count }, () =>
    Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(null) }),
  );
  const ports = probes.map((probe) => probe.port as number);
  for (const probe of probes) void probe.stop(true);
  return ports;
}

function fromEnvironment(name: string): string | undefined {
  return process.env[name];
}

export function exampleEnvironment(): ExampleEnvironment {
  const existing = {
    port: fromEnvironment('TERMINAL_EXAMPLE_PORT'),
    ownServerPort: fromEnvironment('TERMINAL_EXAMPLE_OWN_SERVER_PORT'),
    refusalPort: fromEnvironment('TERMINAL_EXAMPLE_REFUSAL_PORT'),
    startToken: fromEnvironment('TERMINAL_EXAMPLE_START_TOKEN'),
  };
  if (
    existing.port !== undefined &&
    existing.ownServerPort !== undefined &&
    existing.refusalPort !== undefined &&
    existing.startToken !== undefined
  ) {
    return {
      port: Number(existing.port),
      ownServerPort: Number(existing.ownServerPort),
      refusalPort: Number(existing.refusalPort),
      startToken: existing.startToken,
    };
  }
  const [port, ownServerPort, refusalPort] = freePorts(3) as [number, number, number];
  const startToken = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
  process.env['TERMINAL_EXAMPLE_PORT'] = String(port);
  process.env['TERMINAL_EXAMPLE_OWN_SERVER_PORT'] = String(ownServerPort);
  process.env['TERMINAL_EXAMPLE_REFUSAL_PORT'] = String(refusalPort);
  process.env['TERMINAL_EXAMPLE_START_TOKEN'] = startToken;
  return { port, ownServerPort, refusalPort, startToken };
}
