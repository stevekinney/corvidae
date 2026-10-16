import { isLoopbackListener } from '@lostgradient/ventriloquist/websocket';

export const DEFAULT_HOSTNAME = '127.0.0.1';
export const DEFAULT_PORT = 54240;

export type ServerConfiguration = {
  readonly hostname: string;
  readonly port: number;
};

/** A refusal the person who started the server should read: the message is the whole explanation. */
export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';
}

function flagValue(argumentsList: readonly string[], name: string): string | undefined {
  const flag = `--${name}`;
  let found: string | undefined;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index] as string;
    let value: string | undefined;
    if (argument === flag) {
      value = argumentsList[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new ConfigurationError(`${flag} needs a value.`);
      }
      index += 1;
    } else if (argument.startsWith(`${flag}=`)) {
      value = argument.slice(flag.length + 1);
    }
    if (value !== undefined) {
      if (found !== undefined) throw new ConfigurationError(`${flag} was given more than once.`);
      found = value;
    }
  }
  return found;
}

/**
 * Read `--hostname` and `--port` from the command line. The example is a local development tool
 * that starts shells, so it binds loopback only: any other hostname is refused here, before a
 * socket exists, and the transport refuses it again if this check is ever bypassed.
 */
export function parseConfiguration(argumentsList: readonly string[]): ServerConfiguration {
  const known = new Set(['--hostname', '--port']);
  for (const argument of argumentsList) {
    if (argument.startsWith('--') && !known.has(argument.split('=')[0] as string)) {
      throw new ConfigurationError(`Unknown option ${argument}. Use --hostname and --port.`);
    }
  }
  const requested = flagValue(argumentsList, 'hostname') ?? DEFAULT_HOSTNAME;
  const hostname =
    requested.startsWith('[') && requested.endsWith(']') ? requested.slice(1, -1) : requested;
  if (!isLoopbackListener(hostname)) {
    throw new ConfigurationError(
      `Refusing to bind ${JSON.stringify(hostname)}. The terminal example starts shells on this machine, so it listens on a loopback address only (127.0.0.1, ::1 or localhost).`,
    );
  }
  const portText = flagValue(argumentsList, 'port');
  const port = portText === undefined ? DEFAULT_PORT : Number(portText);
  if (
    (portText !== undefined && !/^\d+$/.test(portText)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new ConfigurationError(
      `Invalid port ${JSON.stringify(portText)}. Use a whole number from 1 to 65535; the served origin must be known before the server starts, so 0 is not allowed.`,
    );
  }
  return { hostname, port };
}

/** The origin a browser sees for this listener, and the only origin the upgrade will accept. */
export function servedOrigin(configuration: ServerConfiguration): string {
  const host = configuration.hostname.includes(':')
    ? `[${configuration.hostname}]`
    : configuration.hostname;
  return `http://${host}:${configuration.port}`;
}
