#!/usr/bin/env bun
/**
 * On-demand smoke test of Bureau's MCP adapter against Claude Code (COR-839),
 * ported from protokit's Claude Code connector harness. It needs a real
 * `claude` on `PATH`, so it runs by hand, outside `bun run validate`:
 *
 *   bun run --filter=@lostgradient/interborough smoke:claude-code-mcp
 *
 * It starts Interborough on a loopback port with a scratch home, registers
 * `/bureau/mcp` with `claude mcp add --transport http` under an isolated
 * `CLAUDE_CONFIG_DIR` (so the invoking user's own Claude Code configuration is
 * never read or written), and asks `claude mcp list`, which connects to every
 * registered server, whether the connection succeeds. The server is removed
 * and the scratch directories deleted whatever happens. Interborough needs no
 * OAuth: it listens on loopback and serves every caller as `anonymous:local`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost } from '../src/host/host.ts';

type CliResult = { readonly exitCode: number; readonly output: string };

async function claude(args: readonly string[], configDirectory: string): Promise<CliResult> {
  const child = Bun.spawn(['claude', ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDirectory },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill(), 60_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, output: `${stdout}${stderr}` };
}

async function main(): Promise<number> {
  if (Bun.which('claude') === null) {
    console.error('[smoke:claude-code-mcp] `claude` is not on PATH; install Claude Code first.');
    return 1;
  }
  const home = await mkdtemp(join(tmpdir(), 'interborough-mcp-smoke-home-'));
  const configDirectory = await mkdtemp(join(tmpdir(), 'interborough-mcp-smoke-claude-'));
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
  const serverName = `interborough-bureau-${crypto.randomUUID().slice(0, 8)}`;
  const endpoint = new URL('/bureau/mcp', host.url).href;
  const problems: string[] = [];
  try {
    const version = await claude(['--version'], configDirectory);
    console.log(`[smoke:claude-code-mcp] claude --version -> ${version.output.trim()}`);
    const added = await claude(
      ['mcp', 'add', '--transport', 'http', serverName, endpoint, '-s', 'local'],
      configDirectory,
    );
    if (added.exitCode !== 0)
      problems.push(`claude mcp add exited ${added.exitCode}: ${added.output}`);
    const listed = await claude(['mcp', 'list'], configDirectory);
    const line = listed.output.split('\n').find((entry) => entry.includes(serverName)) ?? '';
    console.log(
      `[smoke:claude-code-mcp] claude mcp list -> ${line.trim() || listed.output.trim()}`,
    );
    if (!/connected/i.test(line) || /failed|not connected/i.test(line)) {
      problems.push(`claude mcp list did not report ${serverName} as connected`);
    }
    // The MCP Apps (COR-910): the endpoint reads each `ui://` resource as an MCP App page and links
    // a tool to it.
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
    const apps = [
      { uri: 'ui://bureau/run-inspector/v1', tool: 'bureau.tasks.inspect' },
      { uri: 'ui://bureau/pending-review/v1', tool: 'bureau.reviews.list' },
    ];
    const tools = await rpc(3, 'tools/list', {});
    let id = 10;
    for (const { uri, tool } of apps) {
      const read = await rpc((id += 1), 'resources/read', { uri });
      const content = read?.result?.contents?.[0];
      if (content?.mimeType !== 'text/html;profile=mcp-app' || typeof content?.text !== 'string') {
        problems.push(`resources/read ${uri} did not answer an MCP App page`);
      }
      const linked = tools?.result?.tools?.find(
        (candidate: { name: string }) => candidate.name === tool,
      );
      if (linked?._meta?.ui?.resourceUri !== uri) {
        problems.push(`${tool} is not linked to ${uri}`);
      }
      console.log(`[smoke:claude-code-mcp] ${uri} -> ${content?.text?.length ?? 0} bytes`);
    }
    await claude(['mcp', 'remove', serverName, '-s', 'local'], configDirectory);
  } finally {
    await host.close();
    await rm(home, { recursive: true, force: true });
    await rm(configDirectory, { recursive: true, force: true });
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[smoke:claude-code-mcp] FAILED: ${problem}`);
    return 1;
  }
  console.log(`[smoke:claude-code-mcp] Claude Code connected to ${endpoint}.`);
  return 0;
}

if (import.meta.main) process.exit(await main());
