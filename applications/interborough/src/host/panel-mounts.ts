/**
 * Every MCP App the Bureau MCP adapter serves (COR-910): each app a running plugin contributes
 * (COR-1888), built into a self-contained page and served as its `ui://` resource, and the tool
 * metadata that links a tool to the page, merged into the one pair the adapter accepts.
 */
import type { OperationMcpResource } from '@lostgradient/backchannel-mcp';
import type { BureauPlugins } from '@lostgradient/bureau';
import type { PluginPanel, PluginPanelPlacement } from '@lostgradient/interborough-plugin';
import type { Storage } from '@lostgradient/storage';
import { z } from 'zod';

import { createPanelBuildCache, type PanelBuildCache } from './panel-build-cache.ts';
import {
  buildPanelPage,
  digestOf,
  panelBuildCodeDigest,
  panelBuildVersions,
  withPanelBuildDeadline,
  type BuiltPanel,
  type PanelBuildClock,
  type PanelPageBuilder,
} from './panel-build.ts';

/**
 * Environment variable naming the archive's prebuilt workspace-plugin panel directory: one
 * `<panel name>.json` per panel, each a {@link PrebuiltPanel}.
 */
export const PANEL_PREBUILT_DIRECTORY_VARIABLE = 'INTERBOROUGH_PANEL_DIRECTORY';

/**
 * A panel the release built before it shipped (COR-2217), as `<panel name>.json` holds it: the page,
 * its digest, and the `ui://` URI it was built for. The URI is what ties the file to one panel, since
 * a panel's name is unique only within its plugin and the file is named by it alone.
 */
export const prebuiltPanelSchema = z.object({
  uri: z.string().min(1),
  html: z.string().min(1),
  contentDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

/** What {@link prebuiltPanelSchema} parses. */
export type PrebuiltPanel = z.infer<typeof prebuiltPanelSchema>;

/**
 * The text of the file a release writes for the panel at `uri`. It is checked with the same schema
 * and digest the host checks it with, so a release cannot ship a file the host would refuse.
 */
export function prebuiltPanelFile(uri: string, page: BuiltPanel): string {
  const prebuilt = prebuiltPanelSchema.parse({
    uri,
    html: page.html,
    contentDigest: page.contentDigest,
  });
  if (digestOf(prebuilt.html) !== prebuilt.contentDigest) {
    throw new Error(`The page built for ${uri} does not match its contentDigest`);
  }
  return JSON.stringify(prebuilt);
}

/**
 * The prebuilt page for `app`, or why it cannot be used. `undefined` for both answers means there is
 * no file for it, which is the ordinary state of a panel a release did not build, such as a folder
 * plugin's. A file that is there and is not this panel's page, in bytes or in identity, gives a
 * reason and never a page: the host builds the panel itself, so the reason is for a person to read.
 */
async function prebuiltPage(
  directory: string,
  app: Pick<PluginPanel, 'name' | 'uri'>,
): Promise<{ readonly page?: BuiltPanel; readonly reason?: string }> {
  const file = Bun.file(`${directory}/${app.name}.json`);
  if (!(await file.exists())) return {};
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch (error) {
    return { reason: `${app.name}.json is not JSON: ${failureMessage(error)}` };
  }
  const shaped = prebuiltPanelSchema.safeParse(parsed);
  if (!shaped.success) {
    return {
      reason: `${app.name}.json is not a prebuilt panel: ${shaped.error.issues
        .map((issue) => `${issue.path.join('.') || 'it'} ${issue.message}`)
        .join('; ')}`,
    };
  }
  if (shaped.data.uri !== app.uri) {
    return { reason: `${app.name}.json was built for ${shaped.data.uri}, not ${app.uri}` };
  }
  if (digestOf(shaped.data.html) !== shaped.data.contentDigest) {
    return { reason: `${app.name}.json does not match its own contentDigest` };
  }
  return { page: { html: shaped.data.html, contentDigest: shaped.data.contentDigest } };
}

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
      return placement.when === 'failed' ? { kind: 'run', when: 'failed' } : { kind: 'run' };
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

/** A panel whose prebuilt page the host could not use, so it built the panel itself (COR-2217). */
export type PanelFallback = {
  /** The contributing plugin's name. */
  readonly plugin: string;
  /** The app's name within the plugin. */
  readonly app: string;
  /** Why the prebuilt file was not used. */
  readonly reason: string;
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

/** The digest of the page served under a URI, waiting to be recorded once the host is up. */
export type PanelDigest = {
  /** The app's `ui://` resource URI. */
  readonly uri: string;
  /** The digest of the page served under it. */
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

/** What {@link panelMounts} reads besides the contributed panels and the digest storage. */
export type PanelMountOptions = {
  /** The release's prebuilt pages, one `<panel name>.json` each (COR-2217). */
  readonly prebuiltDirectory?: string;
  /** The host's `node_modules`, which a build resolves `svelte` and Cinder from (COR-2216). */
  readonly dependencies?: string;
  /** Where built pages are kept between starts (COR-2219). Without one, every start builds. */
  readonly cache?: PanelBuildCache;
  /** What builds a page, `buildPanelPage` unless a test counts or stalls the build. */
  readonly build?: PanelPageBuilder;
  /** The timer that bounds a build, the platform's unless a test fires it. */
  readonly clock?: PanelBuildClock;
  /** Receives each panel's outcome and elapsed time for startup qualification. */
  readonly observe?: (event: {
    plugin: string;
    panel: string;
    outcome: 'ready' | 'failed';
    milliseconds: number;
    built: boolean;
    prebuilt: boolean;
  }) => void;
};

/**
 * Build every contributed app once and merge their resources and tool metadata. An app is linked
 * from its `opensFromTool`, which Bureau composition keeps to one app (a second plugin's app is
 * skipped with `name-clash`). An app whose page does not build is left out and reported in
 * `failures`, never thrown: a plugin's contribution must not stop the host from starting.
 *
 * A page whose digest differs from the record an earlier start left in `storage` under its URI is
 * listed in `changes` and still served: a URI names a contract, so a change in its bytes is for a
 * person to see, not a reason to refuse the page (COR-2210). An unreadable record counts as
 * absent. This writes nothing: the digests to record, for each page that built and differs from
 * its record, come back in `pendingDigests` for {@link commitPanelDigests}, which the host runs
 * once its listener is up.
 */
export async function panelMounts(
  contributed: ContributedPanels,
  storage: Storage,
  options: PanelMountOptions = {},
) {
  const { prebuiltDirectory, dependencies } = options;
  const build = options.build ?? buildPanelPage;
  // Without a directory nothing is stored, and two builds of one panel at once still share one.
  const cache = options.cache ?? createPanelBuildCache();
  // What a build depends on besides the panel's files: the root it resolves svelte and Cinder from,
  // what those are, and the host's own build code (COR-2219).
  const versions = { ...panelBuildVersions(dependencies), buildCode: panelBuildCodeDigest() };
  const built = await Promise.all(
    contributed.map(async ({ plugin, app }) => {
      const started = performance.now();
      let reason: string | undefined;
      let builtPage = false;
      let usedPrebuilt = false;
      // What a build reads of the plugin's panel, copied before the first await: the object is the
      // plugin's, and a build that outlasts a change to it must still build what was contributed.
      const { name, uri, title, entry } = { ...app, entry: app.entry.href };
      const styles = app.styles ?? '';
      try {
        const prebuilt =
          prebuiltDirectory === undefined || prebuiltDirectory.trim() === ''
            ? {}
            : await prebuiltPage(prebuiltDirectory, { name, uri });
        reason = prebuilt.reason;
        usedPrebuilt = prebuilt.page !== undefined;
        const page =
          prebuilt.page ??
          // A build that does not finish in time is a failure of this panel, and the host starts.
          (await withPanelBuildDeadline(
            cache.serve(`${plugin}/${name}`, { entry, title, styles, ...versions }, () => {
              builtPage = true;
              return build({
                entry,
                title,
                styles,
                ...(dependencies === undefined ? {} : { dependencies }),
              });
            }),
            title,
            options.clock,
          ));
        options.observe?.({
          plugin,
          panel: name,
          outcome: 'ready',
          milliseconds: performance.now() - started,
          built: builtPage,
          prebuilt: usedPrebuilt,
        });
        return { plugin, app, page, ...(reason === undefined ? {} : { reason }) };
      } catch (error) {
        options.observe?.({
          plugin,
          panel: name,
          outcome: 'failed',
          milliseconds: performance.now() - started,
          built: builtPage,
          prebuilt: usedPrebuilt,
        });
        const message = failureMessage(error);
        return {
          plugin,
          app,
          failure: { plugin, app: app.name, message } satisfies PanelFailure,
          ...(reason === undefined ? {} : { reason }),
        };
      }
    }),
  );
  const toolMeta: Record<string, Readonly<Record<string, unknown>>> = {};
  const resources: (OperationMcpResource & { readonly text: string })[] = [];
  const failures: PanelFailure[] = [];
  const fallbacks: PanelFallback[] = [];
  const apps: ServedPanel[] = [];
  for (const entry of built) {
    if (entry.reason !== undefined) {
      fallbacks.push({ plugin: entry.plugin, app: entry.app.name, reason: entry.reason });
    }
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
  const pendingDigests: PanelDigest[] = [];
  for (const entry of built) {
    if ('failure' in entry) continue;
    const { plugin, app, page } = entry;
    const previousDigest = await servedDigest(storage, app.uri);
    if (previousDigest === page.contentDigest) continue;
    // Not written here: the host commits it once its listener is up, so a start that fails
    // after this leaves the record alone and the next start reports the change.
    pendingDigests.push({ uri: app.uri, contentDigest: page.contentDigest });
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
  return {
    resources,
    toolMeta,
    defaultToolMeta: MODEL_ONLY_TOOL_META,
    failures,
    fallbacks,
    apps,
    changes,
    pendingDigests,
  };
}

/**
 * Records the digests `panelMounts` found new or changed, one key per URI. The host calls it once
 * its listener is up: a record written earlier would be spent by a start that then fails, and the
 * start after it would report nothing (COR-2210).
 */
export async function commitPanelDigests(
  storage: Storage,
  pending: readonly PanelDigest[],
): Promise<void> {
  for (const { uri, contentDigest } of pending) {
    await storage.put(
      `${PANEL_DIGEST_KEY_PREFIX}${uri}`,
      new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, contentDigest })),
    );
  }
}
