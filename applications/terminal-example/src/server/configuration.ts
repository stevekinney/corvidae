import { isLoopbackListener } from '@lostgradient/ventriloquist/websocket';

export const DEFAULT_HOSTNAME = '127.0.0.1';
export const DEFAULT_PORT = 54240;

export const MINIMUM_START_TOKEN_LENGTH = 16;
export const MAXIMUM_BROWSERS_PER_TOKEN = 256;

export type ServerConfiguration = {
  readonly hostname: string;
  readonly port: number;
  /** A start token the caller chose (tests do); absent, the server makes a random one. */
  readonly startToken: string | undefined;
  /** How many browsers the start URL admits before the server has to be restarted. */
  readonly browsers: number;
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
  const known = new Set(['--hostname', '--port', '--start-token', '--browsers']);
  for (const argument of argumentsList) {
    if (argument.startsWith('--') && !known.has(argument.split('=')[0] as string)) {
      throw new ConfigurationError(
        `Unknown option ${argument}. Use --hostname, --port, --start-token and --browsers.`,
      );
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
  const startToken = flagValue(argumentsList, 'start-token');
  if (startToken !== undefined && startToken.length < MINIMUM_START_TOKEN_LENGTH) {
    throw new ConfigurationError(
      `--start-token needs at least ${MINIMUM_START_TOKEN_LENGTH} characters, or leave it out and the server makes a random one.`,
    );
  }
  const browsersText = flagValue(argumentsList, 'browsers');
  const browsers = browsersText === undefined ? 1 : Number(browsersText);
  if (
    (browsersText !== undefined && !/^\d+$/.test(browsersText)) ||
    browsers < 1 ||
    browsers > MAXIMUM_BROWSERS_PER_TOKEN
  ) {
    throw new ConfigurationError(
      `Invalid --browsers ${JSON.stringify(browsersText)}. Use a whole number from 1 to ${MAXIMUM_BROWSERS_PER_TOKEN}.`,
    );
  }
  return { hostname, port, startToken, browsers };
}

/** The origin a browser sees for this listener, and the only origin the upgrade will accept. */
export function servedOrigin(configuration: ServerConfiguration): string {
  const host = configuration.hostname.includes(':')
    ? `[${configuration.hostname}]`
    : configuration.hostname;
  return `http://${host}:${configuration.port}`;
}
