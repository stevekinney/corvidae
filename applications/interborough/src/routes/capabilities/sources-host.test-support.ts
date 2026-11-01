/**
 * A stand-in for the host's tool-source routes, for the Sources tab tests: it answers
 * `GET /host/tool-sources`, `PUT /host/tool-sources/<id>/tools`, `POST …/authorize`,
 * `GET …/affected-agents` and `DELETE /host/tool-sources/<id>` from state a test holds, and records
 * what it was sent. The real routes are exercised against a real host in
 * `src/host/host-tool-sources.test.ts` and the Playwright suite (`connect-tools.spec.ts`).
 */
import type {
  ToolSourceAgent,
  ToolSourceAuthorization,
  ToolSourceStanding,
  ToolSourceTool,
} from '../../lib/host-tool-sources.ts';

/** One request the stand-in answered. */
export type SourceRequest = { method: string; path: string; body: unknown };

/** What the stand-in holds and how it answers. */
export type FakeToolSources = {
  sources: ToolSourceStanding[];
  lockReason?: 'deployment';
  /** What `POST …/authorize` answers. */
  authorization: ToolSourceAuthorization;
  /** The agent files each source's removal would leave invalid, by source. */
  agents: Record<string, ToolSourceAgent[]>;
  /** Makes the next write answer with this response instead of making the change. */
  refuseNext?: Response | undefined;
  readonly requests: SourceRequest[];
};

/** A tool of a source, read-only by default. */
export function sourceTool(
  source: string,
  tool: string,
  extra: Partial<ToolSourceTool> = {},
): ToolSourceTool {
  return {
    name: `${source}__${tool}`,
    tool,
    acceptsSecrets: false,
    savedAcceptsSecrets: false,
    tier: 'read-only',
    ...extra,
  };
}

/** A loaded source with the tools given. */
export function source(id: string, extra: Partial<ToolSourceStanding> = {}): ToolSourceStanding {
  return {
    id,
    kind: 'mcp',
    localCommand: false,
    state: 'loaded',
    tools: [],
    skipped: [],
    unmatchedSettings: [],
    credentials: [],
    ...extra,
  };
}

/** The route handler for `bureau(…, other)`: answers a tool-source request, and leaves every other one alone. */
export function fakeToolSources(initial: {
  sources: ToolSourceStanding[];
  lockReason?: 'deployment';
  authorization?: ToolSourceAuthorization;
  agents?: Record<string, ToolSourceAgent[]>;
}): { host: FakeToolSources; other: (url: string, init?: RequestInit) => Response | undefined } {
  const host: FakeToolSources = {
    sources: initial.sources,
    authorization: initial.authorization ?? { authorized: true },
    agents: initial.agents ?? {},
    ...(initial.lockReason === undefined ? {} : { lockReason: initial.lockReason }),
    requests: [],
  };
  const other = (url: string, init?: RequestInit): Response | undefined => {
    const path = new URL(url, 'http://localhost').pathname;
    if (!path.startsWith('/host/tool-sources')) return undefined;
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    host.requests.push({ method, path, body });
    if (method !== 'GET' && host.refuseNext !== undefined) {
      const refusal = host.refuseNext;
      host.refuseNext = undefined;
      return refusal;
    }
    const [, , , id, rest] = path.split('/').map(decodeURIComponent);
    const found = host.sources.find((entry) => entry.id === id);
    if (id === undefined) {
      return Response.json({
        sources: host.sources,
        ...(host.lockReason === undefined ? {} : { lockReason: host.lockReason }),
      });
    }
    if (found === undefined) return Response.json({ error: 'not-found' }, { status: 404 });
    if (method === 'PUT' && rest === 'tools') {
      const settings = (body as { tools: Record<string, { acceptsSecrets: boolean }> }).tools;
      found.tools = found.tools.map((tool) =>
        settings[tool.tool] === undefined
          ? tool
          : { ...tool, savedAcceptsSecrets: settings[tool.tool]!.acceptsSecrets },
      );
      if (found.tools.some((tool) => tool.savedAcceptsSecrets !== tool.acceptsSecrets)) {
        found.settingsPending = true;
      }
      return Response.json({ id, changed: true, restartRequired: true });
    }
    if (method === 'POST' && rest === 'authorize') return Response.json(host.authorization);
    if (method === 'GET' && rest === 'affected-agents') {
      return Response.json({
        id,
        tools: found.tools.map((tool) => tool.name),
        affectedAgents: host.agents[id] ?? [],
      });
    }
    if (method === 'DELETE') {
      host.sources = host.sources.filter((entry) => entry !== found);
      return Response.json({ id, changed: true, restartRequired: true, affectedAgents: [] });
    }
    return Response.json({ error: 'failed' }, { status: 500 });
  };
  return { host, other };
}
