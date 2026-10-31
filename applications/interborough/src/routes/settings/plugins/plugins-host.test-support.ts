/**
 * A stand-in for the host's plugin routes, for the Settings › Plugins tests: it answers
 * `GET /host/plugins`, `PUT /host/plugins/<name>`, `PUT /host/plugins/<name>/secrets/<key>` and
 * `POST /host/restart` from state a test holds, records what it was sent, and sends every other
 * request on to the fetch underneath. The real routes are exercised against a real host in
 * `src/host/host-plugins.test.ts`.
 *
 * A restart is modelled as the host does it: `POST /host/restart` answers `202`, the host then
 * stops (its next `downFor` reads fail with a network error), and a host that comes back has loaded
 * what was stored. A host with `restartApplies: false` accepts the request and never stops.
 */
import type { PluginStanding, PluginsSnapshot } from '../../../lib/host-plugins.ts';
import { installFetchImplementation } from '../../../lib/live-source/fetch.test-support.ts';

/** One request the stand-in answered. */
export type HostRequest = { method: string; path: string; body: unknown };

/** A plugin as a test states it; everything it leaves out takes a plain default. */
export type PluginFixture = {
  name: string;
  version?: string;
  description?: string;
  required?: boolean;
  source?: PluginStanding['source'];
  location?: string;
  status?: PluginStanding['status'];
  enabled?: boolean;
  configuration?: unknown;
  contributions?: PluginStanding['contributions'];
  secrets?: { key: string; set: boolean }[];
  problems?: PluginStanding['problems'];
  /** Whether the plugin applies a configuration change at once, so it never waits for a restart. */
  liveConfiguration?: boolean;
};

/** What the stand-in holds and how it answers. */
export type FakePluginHost = {
  /** The plugins as the running host loaded them. A restart makes the stored choices these. */
  plugins: PluginFixture[];
  /** The stored choices, by plugin name. */
  stored: Record<string, { enabled: boolean; configuration: unknown }>;
  /** How many reads fail after a restart before the host answers again. */
  downFor: number;
  /** Whether a restart request makes the host stop. */
  restartApplies: boolean;
  /** Makes the restart request answer with this response instead of accepting it. */
  refuseRestart?: Response;
  /** Makes the restart request fail the way a request that gets no answer does. */
  failRestartRequest?: boolean;
  /** Folders the host could not load, as it reports them. */
  unloaded: PluginsSnapshot['unloaded'];
  /** Makes the next write to a plugin answer with this response instead of making the change. */
  refuseNext?: Response;
  lockReason?: 'deployment';
  /** Makes the next reads fail with a status. */
  failReads: number;
  readonly requests: HostRequest[];
  restore(): void;
};

/** A contribution with the references that name it. */
export function contribution(
  kind: string,
  id: string,
  references: { agents?: number; schedules?: number; waitingRuns?: number } = {},
): PluginStanding['contributions'][number] {
  return {
    kind,
    id,
    references: {
      agents: references.agents ?? 0,
      schedules: references.schedules ?? 0,
      waitingRuns: references.waitingRuns ?? 0,
    },
  };
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function standingOf(host: FakePluginHost, plugin: PluginFixture): PluginStanding {
  const stored = host.stored[plugin.name] ?? {
    enabled: plugin.enabled ?? true,
    configuration: plugin.configuration ?? {},
  };
  const loadedEnabled = plugin.enabled ?? true;
  const loadedConfiguration = plugin.configuration ?? {};
  const secrets = (plugin.secrets ?? []).map((secret) => ({
    key: secret.key,
    generated: false,
    set: secret.set,
    location: `/home/.bungalow/secrets/${secret.key}`,
  }));
  return {
    descriptor: {
      name: plugin.name,
      version: plugin.version ?? '1.0.0',
      description: plugin.description ?? `The ${plugin.name} plugin.`,
      required: plugin.required === true,
      enabledByDefault: true,
    },
    source: plugin.source ?? 'package',
    location: plugin.location ?? `@lostgradient/plugin-${plugin.name}`,
    status: plugin.status ?? (loadedEnabled ? 'running' : 'disabled'),
    problems: plugin.problems ?? [],
    contributions: plugin.contributions ?? [],
    enabled: stored.enabled,
    configuration: stored.configuration,
    secrets,
    restartRequired:
      stored.enabled !== loadedEnabled ||
      (plugin.liveConfiguration !== true &&
        JSON.stringify(stored.configuration) !== JSON.stringify(loadedConfiguration)),
  };
}

/** The snapshot the host reports now. */
export function snapshotOf(host: FakePluginHost): PluginsSnapshot {
  return {
    plugins: host.plugins.map((plugin) => standingOf(host, plugin)),
    unloaded: host.unloaded,
    ...(host.lockReason === undefined ? {} : { lockReason: host.lockReason }),
  };
}

/** The host starting again: what was stored is what runs. */
function restarted(host: FakePluginHost): void {
  host.plugins = host.plugins.map((plugin) => {
    const stored = host.stored[plugin.name];
    if (stored === undefined) return plugin;
    const status = !stored.enabled
      ? 'disabled'
      : plugin.status === 'disabled'
        ? 'running'
        : plugin.status;
    return {
      ...plugin,
      enabled: stored.enabled,
      configuration: stored.configuration,
      ...(status === undefined ? {} : { status }),
    };
  });
}

/** Installs the stand-in over the current `fetch`. Call `restore` before the layer underneath is restored. */
export function installFakePluginHost(
  plugins: PluginFixture[],
  options: { lockReason?: 'deployment'; restartApplies?: boolean; downFor?: number } = {},
): FakePluginHost {
  const underneath = globalThis.fetch;
  const host: FakePluginHost = {
    plugins,
    stored: {},
    downFor: options.downFor ?? 2,
    restartApplies: options.restartApplies ?? true,
    failReads: 0,
    unloaded: [],
    ...(options.lockReason === undefined ? {} : { lockReason: options.lockReason }),
    requests: [],
    restore: () => undefined,
  };
  let stopped = 0;
  let stopping = false;
  const restore = installFetchImplementation(async (input, init) => {
    const path = new URL(urlOf(input), 'http://localhost').pathname;
    if (!path.startsWith('/host/plugins') && path !== '/host/restart') {
      return underneath(input, init);
    }
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (method === 'GET' && stopping) {
      if (stopped < host.downFor) {
        stopped += 1;
        throw new TypeError('Failed to fetch');
      }
      stopping = false;
      restarted(host);
    }
    host.requests.push({ method, path, body });
    if (method === 'GET') {
      if (host.failReads > 0) {
        host.failReads -= 1;
        return Response.json({ error: 'failed' }, { status: 500 });
      }
      return Response.json(snapshotOf(host));
    }
    if (path === '/host/restart') {
      if (host.failRestartRequest === true) throw new TypeError('Failed to fetch');
      if (host.refuseRestart !== undefined) return host.refuseRestart;
      if (host.restartApplies) {
        stopping = true;
        stopped = 0;
      }
      return Response.json({ restarting: true }, { status: 202 });
    }
    if (host.refuseNext !== undefined) {
      const refusal = host.refuseNext;
      delete host.refuseNext;
      return refusal;
    }
    const record = typeof body === 'object' && body !== null ? body : {};
    const parts = path.slice('/host/plugins/'.length).split('/');
    const name = decodeURIComponent(parts[0] ?? '');
    const plugin = host.plugins.find((entry) => entry.name === name);
    if (plugin === undefined)
      return Response.json({ error: 'not-found', message: '' }, { status: 404 });
    if (parts[1] === 'secrets') {
      const key = decodeURIComponent(parts[2] ?? '');
      const secret = plugin.secrets?.find((entry) => entry.key === key);
      if (secret === undefined) {
        return Response.json(
          { error: 'invalid', field: 'key', message: 'not declared' },
          { status: 400 },
        );
      }
      secret.set = true;
      if (plugin.status === 'needs-setup' && plugin.secrets?.every((entry) => entry.set) === true) {
        plugin.status = 'running';
        plugin.problems = [];
      }
      return Response.json({ plugin: name, key, set: true });
    }
    if (plugin.required === true && Reflect.get(record, 'enabled') === false) {
      return Response.json(
        {
          error: 'invalid',
          field: 'enabled',
          message: 'this plugin is required and cannot be turned off.',
        },
        { status: 400 },
      );
    }
    const current = host.stored[name] ?? {
      enabled: plugin.enabled ?? true,
      configuration: plugin.configuration ?? {},
    };
    const enabled = Reflect.get(record, 'enabled');
    host.stored[name] = {
      enabled: typeof enabled === 'boolean' ? enabled : current.enabled,
      configuration: Object.hasOwn(record, 'configuration')
        ? (Reflect.get(record, 'configuration') ?? {})
        : current.configuration,
    };
    return Response.json({
      plugin: name,
      enabled: host.stored[name].enabled,
      configuration: host.stored[name].configuration,
      restartRequired: standingOf(host, plugin).restartRequired,
    });
  });
  host.restore = restore;
  return host;
}
