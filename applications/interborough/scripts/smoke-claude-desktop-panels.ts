#!/usr/bin/env bun
/**
 * On-demand smoke of Interborough's two MCP App panels in Claude Desktop (COR-2220). Claude Desktop
 * cannot be driven by a script, so this runs by hand, outside `bun run validate`:
 *
 *   bun run --filter=@lostgradient/interborough smoke:claude-desktop-panels [--port 8787]
 *
 * It does what needs no Claude Desktop, then guides the by-hand steps:
 *
 *   1. Starts Interborough on a loopback port with a scratch home (no OAuth: every caller is
 *      `anonymous:local`).
 *   2. Checks over `/bureau/mcp` that the two panel resources are served as MCP App pages, that
 *      each is linked to its tool, and that every tool carries the visibility the allowlist states:
 *      a panel tool is visible to the model and the app, every other tool to the model alone.
 *      (The server advertises visibility; the host refuses an app's call to a model-only tool, so
 *      the refusal itself is a by-hand step.)
 *   3. Prints the by-hand steps and a record template, then keeps the server up until Enter (on a
 *      terminal) or Ctrl+C (SIGINT or SIGTERM, when stdin is not a terminal, as under `bun run --filter`).
 *
 * The result is never inferred: the template's host fields stay blank until a person fills them.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost } from '../src/host/host.ts';

const label = '[smoke:claude-desktop-panels]';

const apps = [
  { uri: 'ui://inspectors/run-inspector/v1', tool: 'bureau.tasks.inspect', name: 'run-inspector' },
  {
    uri: 'ui://inspectors/pending-review/v1',
    tool: 'bureau.reviews.list',
    name: 'pending-review',
  },
] as const;

const panelTools = new Set([
  'bureau.tasks.inspect',
  'bureau.tasks.events',
  'bureau.tasks.cancel',
  'bureau.reviews.list',
  'bureau.reviews.get',
  'bureau.reviews.resolve',
  'bureau.workflows.get',
  'bureau.workflows.update',
]);

/** The model-only tool the by-hand step asks Claude Desktop's panel to call, and see refused. */
const probe = { tool: 'a model-only tool' };

function portFromArguments(): number {
  const index = process.argv.indexOf('--port');
  const value = index === -1 ? undefined : Number(process.argv[index + 1]);
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : 0;
}

async function runAutomatedChecks(endpoint: string): Promise<string[]> {
  const problems: string[] = [];
  const rpc = async (id: number, method: string, params: Record<string, unknown>) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const text = await response.text();
    return JSON.parse(text.startsWith('{') ? text : (text.match(/^data: (.*)$/m)?.[1] ?? 'null'));
  };
  const tools = await rpc(1, 'tools/list', {});
  const listedTools: Array<{
    name: string;
    _meta?: { ui?: { resourceUri?: string; visibility?: unknown } };
  }> = tools?.result?.tools ?? [];
  if (listedTools.length === 0) problems.push('tools/list answered no tools');
  let id = 10;
  for (const { uri, tool } of apps) {
    const read = await rpc((id += 1), 'resources/read', { uri });
    const content = read?.result?.contents?.[0];
    if (content?.mimeType !== 'text/html;profile=mcp-app' || typeof content?.text !== 'string') {
      problems.push(`resources/read ${uri} did not answer an MCP App page`);
    }
    if (listedTools.find((candidate) => candidate.name === tool)?._meta?.ui?.resourceUri !== uri) {
      problems.push(`${tool} is not linked to ${uri}`);
    }
    console.log(`${label} ${uri} -> ${content?.text?.length ?? 0} bytes`);
  }
  for (const { name, _meta } of listedTools) {
    const expected = panelTools.has(name) ? ['model', 'app'] : ['model'];
    if (JSON.stringify(_meta?.ui?.visibility) !== JSON.stringify(expected)) {
      problems.push(
        `${name} has visibility ${JSON.stringify(_meta?.ui?.visibility)}, not ${JSON.stringify(expected)}`,
      );
    }
  }
  const modelOnly = listedTools
    .filter((candidate) => !panelTools.has(candidate.name))
    .map((candidate) => candidate.name);
  const chosen = modelOnly.find((name) => name.endsWith('.list')) ?? modelOnly[0];
  if (chosen === undefined) problems.push('no model-only tool exists to probe a refused call');
  else probe.tool = chosen;
  // The host's own panel route refuses a tool outside the panel's allowlist: the refusal that needs
  // no Claude Desktop. (Over `/bureau/mcp` the server only advertises visibility; the host enforces.)
  const origin = new URL(endpoint).origin;
  const refused = await fetch(`${origin}/host/plugins/inspectors/apps/run-inspector/tool-calls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ name: probe.tool, arguments: {} }),
  });
  console.log(
    `${label} a panel call to ${probe.tool} outside its allowlist -> HTTP ${refused.status}`,
  );
  if (refused.status !== 403) {
    problems.push(`a panel call to ${probe.tool} answered ${refused.status}, not 403`);
  }
  console.log(`${label} checked the visibility of ${listedTools.length} tools`);
  return problems;
}

function printGuide(endpoint: string): void {
  console.log(`
${label} Automated checks passed. These steps remain BY HAND in Claude Desktop:

  Prerequisite: this server runs on a scratch home with no model credentials, so no run exists on
  it. Before step 3, set up a model plugin in this server's Interborough UI (the URL above, minus
  /bureau/mcp), start a chat task, and leave one tool call parked at its approval gate; that
  gives one run to inspect and one pending review. Reading the pending-review panel needs that
  parked gate, so do not approve it until step 4 is done.

  1. Connect ${endpoint} to Claude Desktop. Claude Desktop's custom connectors may refuse a
     loopback URL; if so, bridge it from claude_desktop_config.json with a stdio proxy
     (\`npx mcp-remote ${endpoint}\`, adding \`--allow-http\` where it asks). Keep this process
     running while you test; it holds the server.
  2. Note Claude Desktop's version (Claude menu, About Claude Desktop).
  3. Ask Claude to inspect the run with bureau.tasks.inspect.
     CHECK: the run-inspector panel renders inline (liveness, ownership tree, progress).
  4. Ask Claude to list pending reviews with bureau.reviews.list.
     CHECK: the pending-review panel renders, with approve, deny and reject controls.
  5. Call outside the panel's visibility: ${probe.tool} is model-only, so a panel may not call it.
     Claude Desktop gives a person no control to make a panel call it, so this step is only
     observable if the host's developer tools let you run the panel's tool call by hand. Try that;
     if it cannot be done, write "not observable" in the record, never "refused". The refusal on
     the server side (the host's panel route) is checked above and is not a Claude Desktop result.

Paste this record into the pull request for COR-2220 and fill every field from what you saw.
Leave a field "not observed" rather than guessing:

  Claude Desktop host record (COR-2220)
  - Date:
  - Claude Desktop version:
  - Operating system:
  - Endpoint tested: ${endpoint}
  - run-inspector rendered (yes/no, note):
  - pending-review rendered (yes/no, note):
  - Call outside PL4 visibility (${probe.tool}) refused (yes/no, how it appeared):
  - Then change the Claude Desktop row of the panels capability table in
    packages/bureau/README.md to match.
`);
}

type StopSignals = {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};

/**
 * Keeps the server up until the person stops it: Enter on a terminal, otherwise (for example under
 * `bun run --filter`, where stdin is not a TTY) SIGINT or SIGTERM. Removes its listeners afterwards.
 */
export async function waitForStop(options: {
  isTTY: boolean;
  signals: StopSignals;
}): Promise<void> {
  if (options.isTTY) {
    console.log(`${label} Press Enter to stop the server.`);
    const iterator = console[Symbol.asyncIterator]();
    await iterator.next();
    return;
  }
  console.log(`${label} Press Ctrl+C to stop the server.`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      options.signals.off('SIGINT', stop);
      options.signals.off('SIGTERM', stop);
      resolve();
    };
    options.signals.on('SIGINT', stop);
    options.signals.on('SIGTERM', stop);
  });
}

async function main(): Promise<number> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-desktop-smoke-home-'));
  // The host leaves out a panel whose page does not build within 30 seconds (a loaded machine) and
  // still starts, so that panel's tools are advertised model-only. Name that cause, instead of
  // reporting a visibility mismatch that is only its consequence.
  const buildFailures: string[] = [];
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: portFromArguments(),
    log: (message) => {
      console.log(message);
      if (/its panel .* did not build/.test(message)) buildFailures.push(message);
    },
  });
  const endpoint = new URL('/bureau/mcp', host.url).href;
  try {
    const problems = await runAutomatedChecks(endpoint);
    if (buildFailures.length > 0) {
      problems.unshift(
        `a panel did not build, so the checks below mean nothing; run again when the machine is idle (${buildFailures.join('; ')})`,
      );
    }
    if (problems.length > 0) {
      for (const problem of problems) console.error(`${label} FAILED: ${problem}`);
      return 1;
    }
    printGuide(endpoint);
    await waitForStop({ isTTY: process.stdin.isTTY, signals: process });
  } finally {
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
  return 0;
}

if (import.meta.main) process.exit(await main());
