import { readPreferences, writePreferences } from './cli-client-preferences.ts';
import type { CliClientDependencies, CliCommandResult, Parsed } from './cli-client.ts';

type UrlValidator = (value: string) => URL | undefined;

/** Execute connection preference operations without contacting a host. */
export async function executeConnection(
  parsed: Parsed,
  dependencies: CliClientDependencies,
  loopbackUrl: UrlValidator,
): Promise<CliCommandResult> {
  const preferences = await readPreferences(dependencies);
  const action = parsed.arguments[0];
  if (action === 'list') {
    const all = parsed.options.get('all') === true;
    const limit = Number(parsed.options.get('limit') ?? 50);
    const start = Number(parsed.options.get('cursor') ?? 0);
    if (!all && (!Number.isInteger(limit) || limit <= 0))
      throw Object.assign(new Error('Option --limit must be a positive integer.'), { usage: true });
    if (!Number.isInteger(start) || start < 0)
      throw Object.assign(new Error('Option --cursor must be a nonnegative page cursor.'), {
        usage: true,
      });
    const data = all
      ? preferences.connections
      : preferences.connections.slice(start, start + limit);
    const nextCursor =
      all || start + data.length >= preferences.connections.length
        ? null
        : String(start + data.length);
    return { data, metadata: { cursor: nextCursor, page: { limit: all ? null : limit, all } } };
  }
  const name = parsed.arguments[1];
  if (action === 'add') {
    const url = String(parsed.options.get('url') ?? '');
    if (!name || loopbackUrl(url) === undefined)
      throw Object.assign(new Error('connection add requires a loopback --url.'), { usage: true });
    const next = preferences.connections
      .filter((entry) => entry.name !== name)
      .concat({
        name,
        url,
        ...(typeof parsed.options.get('credential-reference') === 'string'
          ? { credentialReference: String(parsed.options.get('credential-reference')) }
          : {}),
      });
    await writePreferences(
      {
        connections: next,
        ...(preferences.activeConnection === undefined
          ? {}
          : { activeConnection: preferences.activeConnection }),
      },
      dependencies,
    );
    return { data: next.find((entry) => entry.name === name) };
  }
  if (action === 'use' && name && preferences.connections.some((entry) => entry.name === name)) {
    await writePreferences(
      { connections: preferences.connections, activeConnection: name },
      dependencies,
    );
    return { data: { activeConnection: name } };
  }
  if (action === 'remove' && name) {
    const next = preferences.connections.filter((entry) => entry.name !== name);
    await writePreferences(
      {
        connections: next,
        ...(preferences.activeConnection === undefined || preferences.activeConnection === name
          ? {}
          : { activeConnection: preferences.activeConnection }),
      },
      dependencies,
    );
    return { data: { removed: name } };
  }
  throw Object.assign(new Error('Usage: connection list|add|use|remove.'), { usage: true });
}
