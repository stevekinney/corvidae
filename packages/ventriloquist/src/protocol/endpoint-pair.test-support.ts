import { ClientEndpoint } from './client-endpoint.ts';
import { HostEndpoint, type HostEndpointOptions } from './host-endpoint.ts';
import type { Capabilities, RequestedMode } from './messages.ts';

export const SESSION_IDENTIFIER = '0b6f0c3e-8a1d-4c55-9a64-2f6e9b7d1c10';
export const OTHER_SESSION_IDENTIFIER = '7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5';
export const TOKEN = 'token-that-must-never-appear-in-a-failure';

export const PTY_CAPABILITIES: Capabilities = {
  mode: 'pty',
  input: true,
  resize: true,
  kill: true,
  readOnly: false,
};

export const READ_ONLY_CAPABILITIES: Capabilities = {
  mode: 'pty',
  input: false,
  resize: false,
  kill: true,
  readOnly: true,
};

export const PIPE_CAPABILITIES: Capabilities = {
  mode: 'pipe',
  input: true,
  resize: false,
  kill: true,
  readOnly: false,
};

export const OUTPUT_ONLY_CAPABILITIES: Capabilities = {
  mode: 'output-only',
  input: false,
  resize: false,
  kill: false,
  readOnly: true,
};

/** Unwrap a result the test expects to succeed. */
export function expectOk<Value>(
  result:
    | { readonly ok: true; readonly value: Value }
    | { readonly ok: false; readonly failure: unknown },
): Value {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.failure)}`);
  return result.value;
}

export type ConnectedPair = {
  readonly host: HostEndpoint;
  readonly client: ClientEndpoint;
  readonly generation: number;
};

/** Run the whole handshake between a fresh host and client and return both, attached. */
export function connect(
  options: {
    readonly capabilities?: Capabilities;
    readonly requestedMode?: RequestedMode;
    readonly host?: HostEndpointOptions;
    readonly generation?: number;
  } = {},
): ConnectedPair {
  const generation = options.generation ?? 1;
  const host = new HostEndpoint(options.host);
  const client = new ClientEndpoint({
    sessionId: SESSION_IDENTIFIER,
    requestedMode: options.requestedMode ?? 'interactive',
    token: TOKEN,
  });
  expectOk(host.receive(expectOk(client.hello())));
  const capabilities = expectOk(
    host.issueCapabilities({
      generation,
      capabilities: options.capabilities ?? PTY_CAPABILITIES,
    }),
  );
  expectOk(client.receive(capabilities));
  return { host, client, generation };
}
