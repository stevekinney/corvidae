/**
 * A stand-in for the host's tool-source routes, for the Sources tab tests: it answers
 * `GET /host/tool-sources`, `PUT /host/tool-sources/<id>/tools`, `POST …/authorize`,
 * `GET …/affected-agents`, `DELETE /host/tool-sources/<id>`, `POST …/test` (COR-2022), and (COR-1991) `POST …/probe`,
 * `PUT /host/tool-sources/<id>`, `POST /host/openapi-inspection` (COR-2022) and `POST /host/restart`
 * from state a test holds, and records
 * what it was sent. The real routes are exercised against a real host in
 * `src/host/host-tool-sources.test.ts` and the Playwright suite (`connect-tools.spec.ts`).
 */
import type {
  OpenApiInspection,
  ToolSourceAgent,
  ToolSourceAuthorization,
  ToolSourceProbe,
  ToolSourceStanding,
  ToolSourceTool,
  ToolSourceToolSettings,
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
  /** What `POST …/probe` answers. */
  probe: ToolSourceProbe;
  /**
   * What `POST /host/openapi-inspection` answers (COR-2022). Left out, a spec reads as not one,
   * with the host's words.
   */
  inspection?: OpenApiInspection | undefined;
  /** Makes the next probe answer with this response instead of `probe`. */
  refuseProbeNext?: Response | undefined;
  /**
   * What `POST …/test` answers for a saved source (COR-2022). Left out, it lists the source's own
   * tools, as a source that answers does.
   */
  testAnswer?: ToolSourceProbe | undefined;
  /** When a test that lists the tools reached the source, as an ISO 8601 time. Left out, `lastTested` is not moved. */
  testedAt?: string | undefined;
  /** Makes the next test answer with this response instead of `testAnswer`. */
  refuseTestNext?: Response | undefined;
  /** What `POST /host/restart` answers. */
  restart: Response;
  /** Whether a `202` really restarts the host, so the sources waiting for it load. Off: nothing supervises it. */
  restartApplies: boolean;
  /** Makes `POST /host/restart` fail as a connection that dropped does. */
  restartUnreachable: boolean;
  /** How many reads of the list fail, as the host's do while it is stopped. */
  downReads: number;
  /** How many times the host was asked to restart. */
  restarts: number;
  /** Makes the next write answer with this response instead of making the change. */
  refuseNext?: Response | undefined;
  /** Makes the next removal take the source out and then answer with this response, as a `partial` one does. */
  removeThenAnswer?: Response | undefined;
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
    // A copy, so a write one test makes never reaches the shared fixture the next test starts from.
    sources: structuredClone(initial.sources),
    authorization: initial.authorization ?? { authorized: true },
    probe: { outcome: 'listed', tools: [], skipped: [] },
    restart: Response.json({ restarting: true }, { status: 202 }),
    restartApplies: true,
    restartUnreachable: false,
    downReads: 0,
    restarts: 0,
    agents: initial.agents ?? {},
    ...(initial.lockReason === undefined ? {} : { lockReason: initial.lockReason }),
    requests: [],
  };
  const other = (url: string, init?: RequestInit): Response | undefined => {
    const path = new URL(url, 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (path === '/host/restart' && method === 'POST') {
      host.requests.push({ method, path, body });
      host.restarts += 1;
      if (host.restartUnreachable) throw new TypeError('The connection dropped.');
      const answer = host.restart.clone();
      if (answer.status === 202 && host.restartApplies) {
        // The host starts again with every saved source loaded.
        host.sources = host.sources.map((entry) =>
          entry.state === 'pending-restart' ? { ...entry, state: 'loaded' } : entry,
        );
      }
      return answer;
    }
    if (path === '/host/openapi-inspection' && method === 'POST') {
      host.requests.push({ method, path, body });
      const fileName = (body as { fileName?: string }).fileName ?? null;
      return Response.json(
        host.inspection ?? {
          outcome: 'invalid',
          fileName,
          line: null,
          problem: 'It is not YAML or JSON.',
          message: 'This isn’t a valid OpenAPI 3 file. It is not YAML or JSON.',
        },
      );
    }
    if (!path.startsWith('/host/tool-sources')) return undefined;
    host.requests.push({ method, path, body });
    if (method !== 'GET' && host.refuseNext !== undefined) {
      const refusal = host.refuseNext;
      host.refuseNext = undefined;
      return refusal;
    }
    const [, , , id, rest] = path.split('/').map(decodeURIComponent);
    const found = host.sources.find((entry) => entry.id === id);
    if (method === 'POST' && rest === 'probe') {
      const refusal = host.refuseProbeNext;
      host.refuseProbeNext = undefined;
      return refusal ?? Response.json(host.probe);
    }
    if (method === 'PUT' && rest === undefined && id !== undefined) {
      if ((body as { create?: boolean }).create === true && found !== undefined) {
        return Response.json(
          { error: 'exists', field: 'id', message: `Tool source "${id}" is already saved.` },
          { status: 409 },
        );
      }
      const saved = (
        body as {
          source: { kind: 'mcp' | 'openapi'; transport?: { authentication?: { type: string } } };
        }
      ).source;
      const credentials = Object.keys((body as { credentials: object }).credentials);
      const oauth = saved.transport?.authentication?.type === 'oauth';
      // A source a connect adds is loaded at once (COR-2009), with the tools it lists that are on;
      // an OAuth one waits for its sign-in. Replacing a saved source waits for a restart.
      const created = (body as { create?: boolean }).create === true;
      const settings = (body as { tools?: Record<string, ToolSourceToolSettings> }).tools ?? {};
      const listed = host.probe.outcome === 'listed' ? host.probe.tools : [];
      const available = listed
        .filter((tool) => settings[tool.tool]?.enabled !== false)
        .map((tool) => tool.name);
      host.sources = [
        ...host.sources.filter((entry) => entry.id !== id),
        {
          id,
          kind: saved.kind,
          localCommand: false,
          state: !created ? 'pending-restart' : oauth ? 'needs-authorization' : 'loaded',
          tools: [],
          skipped: [],
          unmatchedSettings: [],
          credentials,
          // Only an OAuth source reports whether it holds tokens.
          ...(oauth ? { authorized: false } : {}),
        },
      ];
      return Response.json(
        created
          ? { id, changed: true, restartRequired: false, available }
          : { id, changed: true, restartRequired: true },
      );
    }
    if (id === undefined && method === 'GET' && host.downReads > 0) {
      host.downReads -= 1;
      return new Response('down', { status: 503 });
    }
    if (id === undefined) {
      return Response.json({
        configurationRevision: JSON.stringify(host.sources),
        sources: host.sources,
        ...(host.lockReason === undefined ? {} : { lockReason: host.lockReason }),
      });
    }
    if (found === undefined) return Response.json({ error: 'not-found' }, { status: 404 });
    if (method === 'POST' && rest === 'test') {
      const refusal = host.refuseTestNext;
      host.refuseTestNext = undefined;
      if (refusal !== undefined) return refusal;
      const answer: ToolSourceProbe = host.testAnswer ?? {
        outcome: 'listed',
        tools: found.tools.map((tool) => ({ name: tool.name, tool: tool.tool, tier: tool.tier })),
        skipped: [],
      };
      if (answer.outcome === 'listed' && host.testedAt !== undefined) {
        found.lastTested = host.testedAt;
      }
      return Response.json(answer);
    }
    if (method === 'PUT' && rest === 'tools') {
      // A field left out keeps its saved value, as the host merges them (COR-2022).
      const settings = (body as { tools: Record<string, ToolSourceToolSettings> }).tools;
      found.tools = found.tools.map((tool) => {
        const change = settings[tool.tool];
        if (change === undefined) return tool;
        const next = { ...tool };
        if (change.acceptsSecrets !== undefined) next.savedAcceptsSecrets = change.acceptsSecrets;
        if (change.enabled !== undefined) next.savedEnabled = change.enabled;
        if (change.approval === null) {
          delete next.approval;
          delete next.approvalSaved;
        } else if (change.approval !== undefined) {
          next.approval = change.approval;
          next.approvalSaved = true;
        }
        return next;
      });
      if (
        found.tools.some(
          (tool) =>
            tool.savedAcceptsSecrets !== tool.acceptsSecrets ||
            (tool.savedEnabled ?? tool.enabled ?? true) !== (tool.enabled ?? true),
        )
      ) {
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
      if (host.removeThenAnswer !== undefined) {
        const answer = host.removeThenAnswer;
        host.removeThenAnswer = undefined;
        return answer;
      }
      return Response.json({
        id,
        changed: true,
        restartRequired: true,
        affectedAgents: host.agents[id] ?? [],
      });
    }
    return Response.json({ error: 'failed' }, { status: 500 });
  };
  return { host, other };
}
