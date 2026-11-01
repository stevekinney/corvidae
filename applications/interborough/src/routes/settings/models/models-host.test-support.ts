/**
 * A stand-in for the host's provider routes, for the Models page tests: it answers
 * `GET /host/providers`, `PUT /host/providers/<name>`, `PUT /host/catalog` and
 * `POST /host/providers/reload`, and `DELETE /host/providers/<name>` from state a test holds, records what it was sent, and sends every
 * other request on to the fetch underneath. The real routes are exercised against a real host in
 * `src/host/host-provider-changes.test.ts` and the Playwright suite.
 */
import type { CatalogEdit, ProviderModel } from '../../../lib/host-providers.ts';
import { installFetchImplementation } from '../../../lib/live-source/fetch.test-support.ts';

/** One request the stand-in answered. */
export type HostRequest = { method: string; path: string; body: unknown };

/** What the stand-in holds and how it answers a write. */
export type FakeHost = {
  /** The providers, by name, with whether each has a key. */
  keys: Record<string, boolean>;
  /** The catalog edits stored. */
  catalog: CatalogEdit[];
  /** The models each provider offers once it has a key, before the edits. */
  offered: Record<string, ProviderModel[]>;
  lockReason?: 'deployment';
  /** Makes the next write answer with this response instead of making the change. */
  refuseNext?: Response;
  readonly requests: HostRequest[];
  restore(): void;
};

export function model(
  provider: string,
  name: string,
  extra: Partial<ProviderModel> = {},
): ProviderModel {
  return {
    provider,
    model: name,
    aliases: [],
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    streaming: true,
    tools: true,
    structuredOutput: true,
    images: false,
    pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 15, currency: 'USD' },
    off: false,
    ...extra,
  };
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** The models offered now: each connected provider's, with the stored edits laid over them. */
function modelsOf(host: FakeHost): ProviderModel[] {
  const rows = Object.entries(host.keys)
    .filter(([, connected]) => connected)
    .flatMap(([name]) => host.offered[name] ?? []);
  const shown = rows.map((row) => {
    const edit = host.catalog.find(
      (entry) =>
        entry.provider === row.provider &&
        (entry.model === row.model || row.aliases.includes(entry.model)),
    );
    return edit === undefined
      ? row
      : {
          ...row,
          off: edit.off === true,
          contextWindowTokens: edit.contextWindowTokens ?? row.contextWindowTokens,
        };
  });
  for (const edit of host.catalog) {
    if (edit.basedOn === undefined) continue;
    const base = rows.find((row) => row.provider === edit.provider && row.model === edit.basedOn);
    if (base !== undefined && !shown.some((row) => row.model === edit.model)) {
      shown.push({ ...base, model: edit.model, aliases: [], off: edit.off === true });
    }
  }
  return shown;
}

/** Installs the stand-in over the current `fetch`. Call `restore` before the layer underneath is restored. */
export function installFakeHost(initial: {
  keys: Record<string, boolean>;
  offered: Record<string, ProviderModel[]>;
  catalog?: CatalogEdit[];
  lockReason?: 'deployment';
}): FakeHost {
  const underneath = globalThis.fetch;
  const host: FakeHost = {
    keys: initial.keys,
    offered: initial.offered,
    catalog: initial.catalog ?? [],
    ...(initial.lockReason === undefined ? {} : { lockReason: initial.lockReason }),
    requests: [],
    restore: () => undefined,
  };
  const restore = installFetchImplementation(async (input, init) => {
    const path = new URL(urlOf(input), 'http://localhost').pathname;
    if (!path.startsWith('/host/providers') && path !== '/host/catalog') {
      return underneath(input, init);
    }
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    host.requests.push({ method, path, body });
    if (method === 'GET') {
      return Response.json({
        providers: Object.entries(host.keys).map(([name, hasKey]) => ({
          name,
          configured: hasKey,
          hasKey,
        })),
        catalog: host.catalog,
        models: modelsOf(host),
        ...(host.lockReason === undefined ? {} : { lockReason: host.lockReason }),
      });
    }
    if (host.refuseNext !== undefined) {
      const refusal = host.refuseNext;
      delete host.refuseNext;
      return refusal;
    }
    const record = typeof body === 'object' && body !== null ? body : {};
    if (path === '/host/catalog') {
      // The real host compares the base under its configuration queue and refuses a mismatch.
      const base = Reflect.get(record, 'base') as CatalogEdit[] | undefined;
      if (base !== undefined && JSON.stringify(base) !== JSON.stringify(host.catalog)) {
        return Response.json(
          {
            error: 'conflict',
            message: 'The model catalog changed after it was read, so nothing was saved.',
            catalog: host.catalog,
          },
          { status: 409 },
        );
      }
      host.catalog = Reflect.get(record, 'edits') as CatalogEdit[];
    } else if (method === 'DELETE') {
      host.keys[decodeURIComponent(path.slice('/host/providers/'.length))] = false;
    } else if (path !== '/host/providers/reload') {
      host.keys[decodeURIComponent(path.slice('/host/providers/'.length))] = true;
    }
    return Response.json({ providers: [], catalogRevision: 2 });
  });
  host.restore = restore;
  return host;
}
