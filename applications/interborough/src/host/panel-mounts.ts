/**
 * Every MCP App the Bureau MCP adapter serves (COR-910): each app a running plugin contributes
 * (COR-1888), built into a self-contained page and served as its `ui://` resource, and the tool
 * metadata that links a tool to the page, merged into the one pair the adapter accepts.
 */
import type { BureauPlugins } from '@lostgradient/bureau';
import type { PluginPanelPlacement } from '@lostgradient/interborough-plugin';
import type { Storage } from '@lostgradient/storage';
import type { OperationMcpResource } from '@lostgradient/weft';
import { z } from 'zod';

import { buildPanelPage, type BuiltPanel } from './panel-build.ts';

/** Environment variable naming the archive's prebuilt built-in MCP app directory. */
export const PANEL_PREBUILT_DIRECTORY_VARIABLE = 'INTERBOROUGH_PANEL_DIRECTORY';

/** The MCP App media type. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * The `_meta.ui` every app declares: every origin list empty and every permission absent, which is
 * denied. A page reaches no origin, embeds no frame, sets no base URI, and asks for neither camera,
 * microphone, geolocation, nor clipboard. It asks for no dedicated origin either; the host gives it
 * its default sandbox origin.
 */
export const MCP_APP_UI_META = {
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
  permissions: {},
  prefersBorder: false,
};

/** The `_meta.ui.visibility` of a tool some built panel lists in its `allowedTools`. */
const APP_VISIBILITY: readonly string[] = ['model', 'app'];

/**
 * The `_meta` of every exposed tool no built panel lists: the model may call it, an MCP App page
 * may not (COR-2209).
 */
export const MODEL_ONLY_TOOL_META = { ui: { visibility: ['model'] } } as const;

/**
 * The storage key prefix of the record of the page last served under a URI (COR-2210). The record
 * is `{ schemaVersion: 1, contentDigest }`, one key per URI, so the next start can tell that the
 * bytes under a URI changed.
 */
export const PANEL_DIGEST_KEY_PREFIX = 'interborough-panel-digest:';

const digestRecordSchema = z.object({
  schemaVersion: z.literal(1),
  contentDigest: z.string().min(1),
});

/** The digest an earlier start served under `uri`, or `undefined` when none, or an unreadable record. */
async function servedDigest(storage: Storage, uri: string): Promise<string | undefined> {
  const bytes = await storage.get(`${PANEL_DIGEST_KEY_PREFIX}${uri}`);
  if (bytes === null) return undefined;
  try {
    return digestRecordSchema.parse(JSON.parse(new TextDecoder().decode(bytes))).contentDigest;
  } catch {
    return undefined;
  }
}

/**
 * A placement as the host serves it, copied field by field: the host lists only the fields the
 * placement declares, never whatever else a plugin's object carries.
 */
function servedPlacement(placement: PluginPanelPlacement): PluginPanelPlacement {
  switch (placement.kind) {
    case 'page':
      return {
        kind: 'page',
        path: placement.path,
        ...(placement.sidebar === undefined
          ? {}
          : {
              sidebar: {
                group: placement.sidebar.group,
                // Bureau does not check the icon, and a value that is not text would fail the
                // client's reading of the whole listing, so only text is listed.
                ...(typeof placement.sidebar.icon === 'string'
                  ? { icon: placement.sidebar.icon }
                  : {}),
              },
            }),
      };
    case 'run':
      return { kind: 'run' };
    case 'chat-tool':
      return { kind: 'chat-tool', agentTool: placement.agentTool };
  }
}

/** The apps `bureau.plugins.panels()` lists. */
export type ContributedPanels = ReturnType<BureauPlugins['panels']>;

/** What failed, with each message a failed bundle logged: Bun's own message is only "Bundle failed". */
function failureMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const logged = error instanceof AggregateError ? error.errors : [];
  const details = logged.map((entry: unknown) =>
    entry instanceof Error || (typeof entry === 'object' && entry !== null && 'message' in entry)
      ? String(entry.message)
      : String(entry),
  );
  return [error.message, ...details].join(': ');
}

/** One app the host built and serves: what the routes answer from, fixed at startup. */
export type ServedPanel = {
  /** The contributing plugin's name. */
  readonly plugin: string;
  /** The app's name within the plugin. */
  readonly name: string;
  /** The app's title. */
  readonly title: string;
  /** The app's `ui://` resource URI. */
  readonly uri: string;
  /** The Bureau tool a client runs to open the page; absent for a panel that declares none. */
  readonly opensFromTool?: string;
  /** Where the panel appears in the host: each placement the plugin declared, and none by default. */
  readonly placements: readonly PluginPanelPlacement[];
  /** The Bureau MCP tool names the panel may call, and no others. */
  readonly allowedTools: readonly string[];
  /** Bureau tools callable only by this host panel, outside the generic MCP inventory. */
  readonly hostOnlyTools: readonly string[];
  /** The built, self-contained page. */
  readonly html: string;
};

/** An app whose page could not be built: the plugin, the app's name, and why. */
export type PanelFailure = {
  /** The contributing plugin's name. */
  readonly plugin: string;
  /** The app's name within the plugin. */
  readonly app: string;
  /** The build failure's message. */
  readonly message: string;
};

/** An app whose page is not the bytes an earlier start served under its URI (COR-2210). */
export type PanelChange = {
  /** The contributing plugin's name. */
  readonly plugin: string;
  /** The app's name within the plugin. */
  readonly app: string;
  /** The app's `ui://` resource URI. */
  readonly uri: string;
  /** The digest an earlier start served under the URI. */
  readonly previousDigest: string;
  /** The digest of the page served now. */
  readonly contentDigest: string;
};

/**
 * Lists each of `changes` as a `panel-changed` problem on its plugin and logs it. The pages stay
 * served: the host starts, and a person sees that the bytes under a URI changed (COR-2210).
 */
export function reportPanelChanges(
  plugins: Pick<BureauPlugins, 'reportPanelChange'>,
  changes: readonly PanelChange[],
  log: (message: string) => void,
): void {
  for (const change of changes) {
    plugins.reportPanelChange(
      change.plugin,
      change.app,
      change.uri,
      change.previousDigest,
      change.contentDigest,
    );
    log(
      `Plugin ${change.plugin}: its panel ${change.app} at ${change.uri} changed from ${change.previousDigest} to ${change.contentDigest}.`,
    );
  }
}

/**
 * Build every contributed app once and merge their resources and tool metadata. An app is linked
 * from its `opensFromTool`, which Bureau composition keeps to one app (a second plugin's app is
 * skipped with `name-clash`). An app whose page does not build is left out and reported in
 * `failures`, never thrown: a plugin's contribution must not stop the host from starting.
 *
 * Every page that built records its digest in `storage` under its URI, and one whose digest
 * differs from the record an earlier start left is listed in `changes` and still served: a URI
 * names a contract, so a change in its bytes is for a person to see, not a reason to refuse the
 * page (COR-2210). An unreadable record counts as absent, and a page that did not build writes
 * nothing.
 */
export async function panelMounts(
  contributed: ContributedPanels,
  storage: Storage,
  prebuiltDirectory?: string,
) {
  const built = await Promise.all(
    contributed.map(async ({ plugin, app }) => {
      try {
        const prebuilt =
          prebuiltDirectory === undefined ||
          prebuiltDirectory.trim() === '' ||
          plugin !== 'inspectors'
            ? undefined
            : await Bun.file(`${prebuiltDirectory}/${app.name}.json`)
                .json()
                .catch(() => undefined as BuiltPanel | undefined);
        const page =
          prebuilt ??
          (await buildPanelPage({
            entry: app.entry.href,
            title: app.title,
            styles: app.styles ?? '',
          }));
        return { plugin, app, page };
      } catch (error) {
        const message = failureMessage(error);
        return { plugin, app, failure: { plugin, app: app.name, message } satisfies PanelFailure };
      }
    }),
  );
  const toolMeta: Record<string, Readonly<Record<string, unknown>>> = {};
  const resources: (OperationMcpResource & { readonly text: string })[] = [];
  const failures: PanelFailure[] = [];
  const apps: ServedPanel[] = [];
  for (const entry of built) {
    if ('failure' in entry) {
      failures.push(entry.failure);
      continue;
    }
    const { plugin, app, page } = entry;
    resources.push({
      uri: app.uri,
      name: app.name,
      title: app.title,
      ...(app.description === undefined ? {} : { description: app.description }),
      mimeType: MCP_APP_MIME_TYPE,
      text: page.html,
      _meta: { ui: MCP_APP_UI_META, contentDigest: page.contentDigest },
    });
    apps.push({
      plugin,
      name: app.name,
      title: app.title,
      uri: app.uri,
      ...(app.opensFromTool === undefined ? {} : { opensFromTool: app.opensFromTool }),
      placements: (app.placements ?? []).map(servedPlacement),
      allowedTools: [...app.allowedTools],
      hostOnlyTools: [...(app.hostOnlyTools ?? [])],
      html: page.html,
    });
  }
  // Enforcement is per tool, not per panel (COR-2209): a tool any built panel lists is visible to
  // every app, and every other tool only to the model.
  for (const app of apps) {
    for (const tool of app.allowedTools) toolMeta[tool] = { ui: { visibility: APP_VISIBILITY } };
  }
  // Only a panel that names an opener is linked from a tool; a page panel needs no MCP opener.
  for (const app of apps) {
    if (app.opensFromTool === undefined) continue;
    toolMeta[app.opensFromTool] = { ui: { resourceUri: app.uri, visibility: APP_VISIBILITY } };
  }
  const changes: PanelChange[] = [];
  for (const entry of built) {
    if ('failure' in entry) continue;
    const { plugin, app, page } = entry;
    const previousDigest = await servedDigest(storage, app.uri);
    if (previousDigest === page.contentDigest) continue;
    // Recorded after the comparison, so the warning appears once per change, not on every start.
    await storage.put(
      `${PANEL_DIGEST_KEY_PREFIX}${app.uri}`,
      new TextEncoder().encode(
        JSON.stringify({ schemaVersion: 1, contentDigest: page.contentDigest }),
      ),
    );
    if (previousDigest !== undefined) {
      changes.push({
        plugin,
        app: app.name,
        uri: app.uri,
        previousDigest,
        contentDigest: page.contentDigest,
      });
    }
  }
  return { resources, toolMeta, defaultToolMeta: MODEL_ONLY_TOOL_META, failures, apps, changes };
}
