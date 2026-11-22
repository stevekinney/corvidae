import { describe, expect, test } from 'bun:test';

import { createBureauCatalogSnapshot } from '@lostgradient/bureau';
import { createCatalogSnapshot } from '@lostgradient/weft';

import {
  CLI_COMMAND_REGISTRY,
  CLI_OPERATION_MAPPINGS,
  type CliClientDependencies,
  parseCliArguments,
} from './cli-client.ts';
import {
  CLI_DESTRUCTIVE_ACTIONS,
  CLI_UNCONFIRMED_ACTIONS,
  destructiveActionName,
} from './cli-destructive.ts';
import { executeCliWithDispatchAssertions as executeCli } from './cli-dispatch.test-support.ts';

const PREVIEW = { dryRun: true, target: { kind: 'task', id: 'preview' }, effects: [] };

type Recorder = {
  readonly dependencies: CliClientDependencies;
  /** `METHOD /path` of every request, in order. */
  readonly requests: string[];
  /** The method and params of every JSON-RPC call, in order. */
  readonly calls: Array<{ method: string; params: Record<string, unknown> }>;
};

/** A host that records every request and answers the operations a command can send. */
function recorder(extra: Partial<CliClientDependencies> = {}): Recorder {
  const requests: string[] = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const fetch: NonNullable<CliClientDependencies['fetch']> = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path === '/openrpc.json')
      return Response.json({
        methods: [{ name: 'weft.workflows.cancel' }, { name: 'weft.alerts.list' }],
      });
    if (path === '/host/providers')
      return Response.json({
        configurationRevision: 'r1',
        providers: [
          { name: 'anthropic', connected: true, hasKey: true, nested: { key: 'secret' } },
        ],
      });
    if (path === '/host/tool-sources')
      return Response.json({
        configurationRevision: 'r2',
        sources: [{ id: 'github', kind: 'mcp' }],
      });
    if (path === '/host/plugins')
      return Response.json({
        configurationRevision: 'r3',
        plugins: [{ name: 'openai', enabled: true, configuration: { apiKey: 'secret' } }],
      });
    if (path.startsWith('/host/')) return Response.json({ ok: true });
    if (path.startsWith('/bureau/ag-ui/runs/'))
      return Response.json({ runId: 't1', status: 'aborting' });
    const body = (await request.json()) as {
      id: string;
      method: string;
      params: Record<string, unknown>;
    };
    calls.push({ method: body.method, params: body.params });
    const dry = body.params['dryRun'] === true;
    const result =
      body.method === 'bureau.schedules.get'
        ? { id: 's1', status: 'active', revision: 4 }
        : dry
          ? PREVIEW
          : { receipt: 'canceled', status: 'ok' };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  };
  return {
    dependencies: { fetch, stdin: async () => '{"workflowId":"w1"}', ...extra },
    requests,
    calls,
  };
}

/** Every request that is not a read of discovery, authority or a list. */
function changes(host: Recorder): string[] {
  return host.requests.filter(
    (entry) => !entry.startsWith('GET ') && !entry.endsWith('/bureau/jsonrpc'),
  );
}

const url = ['--url', 'http://localhost'];

/** The commands whose dry run is the server's own answer, with the call each one sends. */
const SERVER_DRY_RUNS: ReadonlyArray<{
  readonly arguments: readonly string[];
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly confirms: boolean;
}> = [
  {
    arguments: ['runs', 'cancel', 't1', '--kind', 'task'],
    method: 'bureau.tasks.cancel',
    params: { taskId: 't1', dryRun: true },
    confirms: false,
  },
  {
    arguments: ['runs', 'cancel', 'w1', '--kind', 'workflow'],
    method: 'weft.workflows.cancel',
    params: { workflowId: 'w1', dryRun: true },
    confirms: false,
  },
  {
    arguments: ['chats', 'cancel', '--task-id', 't1'],
    method: 'bureau.tasks.cancel',
    params: { taskId: 't1', dryRun: true },
    confirms: false,
  },
  {
    arguments: ['goals', 'cancel', 'g1'],
    method: 'bureau.goals.cancel',
    params: { goalRunId: 'g1', dryRun: true },
    confirms: false,
  },
  {
    arguments: ['chats', 'delete', 'c1'],
    method: 'bureau.contexts.delete',
    params: { contextId: 'c1', waitMilliseconds: 0, dryRun: true },
    confirms: true,
  },
  {
    arguments: ['agents', 'delete', 'a1', '--expected-revision', 'h'],
    method: 'bureau.agents.definitions.delete',
    params: { id: 'a1', expectedHash: 'h', dryRun: true },
    confirms: true,
  },
  {
    arguments: ['hooks', 'delete', 'h1'],
    method: 'bureau.hooks.delete',
    params: { hookId: 'h1', dryRun: true },
    confirms: true,
  },
  {
    arguments: ['memory', 'forget', 'm1', '--agent', 'assistant'],
    method: 'bureau.memory.forget',
    params: { agentId: 'assistant', id: 'm1', dryRun: true },
    confirms: true,
  },
];

describe('the CLI registry of destructive commands', () => {
  // spawn-free: nothing runs; the registry and the catalogs are read.
  test('every command mapped to a destructive operation takes --dry-run and is confirmed or named unconfirmed', () => {
    const operations = new Map(
      [...createBureauCatalogSnapshot().operations, ...createCatalogSnapshot().operations].map(
        (operation) => [operation.name, operation],
      ),
    );
    const destructiveVerb = /\.(cancel|delete|disable|forget|pause|remove|disconnect)$/u;
    const covered = new Map<string, string>();
    for (const [name, action] of Object.entries(CLI_DESTRUCTIVE_ACTIONS))
      for (const operation of action.operations)
        covered.set(`${name.split(' ')[0]} ${operation}`, name);

    for (const [command, mapped] of Object.entries(CLI_OPERATION_MAPPINGS)) {
      for (const operation of mapped) {
        const catalog = operations.get(operation);
        const destructive =
          catalog?.supportsDryRun === true ||
          (catalog?.destructive === true && destructiveVerb.test(operation)) ||
          /^DELETE \//u.test(operation) ||
          /^POST \/.*\/cancel$/u.test(operation);
        if (destructive)
          expect(
            covered.has(`${command} ${operation}`),
            `${command} is mapped to ${operation}, which is destructive: add it to CLI_DESTRUCTIVE_ACTIONS`,
          ).toBe(true);
      }
    }
    for (const [name, action] of Object.entries(CLI_DESTRUCTIVE_ACTIONS)) {
      const [command] = name.split(' ');
      const registered = CLI_COMMAND_REGISTRY[command!]!;
      expect(registered.options, `${name} takes --dry-run`).toContain('dry-run');
      for (const operation of action.operations)
        expect(CLI_OPERATION_MAPPINGS[command as keyof typeof CLI_OPERATION_MAPPINGS]).toContain(
          operation,
        );
      if (action.confirms === 'never')
        expect(CLI_UNCONFIRMED_ACTIONS, `${name} is neither confirmed nor named`).toContain(name);
      else expect(registered.options, `${name} confirms, so it takes --yes`).toContain('yes');
    }
  });

  // spawn-free: nothing runs; the registry is read.
  test('the unconfirmed commands are the named five', () => {
    expect([...CLI_UNCONFIRMED_ACTIONS].toSorted()).toEqual([
      'chats cancel',
      'goals cancel',
      'plugins disable',
      'runs cancel',
      'schedules pause',
    ]);
  });

  // spawn-free: nothing runs; arguments are parsed.
  test('--dry-run is refused on an action that has none', () => {
    expect(parseCliArguments(['chats', 'list', '--dry-run'])).toMatchObject({ exitCode: 2 });
    expect(parseCliArguments(['status', '--dry-run'])).toMatchObject({ exitCode: 2 });
    expect(parseCliArguments(['api', 'list', '--dry-run'])).toMatchObject({ exitCode: 2 });
    expect(parseCliArguments(['chats', 'delete', 'c1', '--dry-run'])).toMatchObject({
      command: 'chats',
    });
    const apiCall = parseCliArguments(['api', 'call', 'x', '--dry-run']);
    expect('command' in apiCall && destructiveActionName(apiCall)).toBe('api call');
  });
});

describe('--dry-run', () => {
  for (const scenario of SERVER_DRY_RUNS) {
    // spawn-free: injected fetch records the call.
    test(`${scenario.arguments.slice(0, 2).join(' ')} sends dryRun: true and prints the answer unchanged`, async () => {
      const host = recorder();
      const result = await executeCli(
        [...scenario.arguments, '--dry-run', '--output', 'json', ...url],
        host.dependencies,
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ data: PREVIEW });
      expect(host.calls).toEqual([{ method: scenario.method, params: scenario.params }]);
      expect(changes(host)).toEqual([]);
    });
  }

  // spawn-free: injected fetch records the call.
  test('api sends dryRun: true to an operation whose input takes one, with no --yes', async () => {
    const host = recorder();
    const result = await executeCli(
      ['api', 'call', 'weft.workflows.cancel', '--dry-run', '--input', '-', ...url],
      host.dependencies,
    );
    expect(result.exitCode).toBe(0);
    expect(host.calls).toEqual([
      { method: 'weft.workflows.cancel', params: { workflowId: 'w1', dryRun: true } },
    ]);
  });

  // spawn-free: injected fetch records the call.
  test('api refuses --dry-run for an operation whose input has no dryRun', async () => {
    const host = recorder();
    const result = await executeCli(
      ['api', 'call', 'weft.alerts.list', '--dry-run', '--yes', ...url],
      host.dependencies,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('does not support --dry-run');
    expect(host.calls).toEqual([]);
  });

  const previews: ReadonlyArray<{
    readonly arguments: readonly string[];
    readonly missing: readonly string[];
    readonly target: { kind: string; id: string };
    readonly wouldSend: Record<string, unknown>;
  }> = [
    {
      arguments: ['providers', 'disconnect', 'anthropic'],
      missing: ['providers', 'disconnect', 'nothing'],
      target: { kind: 'provider', id: 'anthropic' },
      wouldSend: {
        method: 'DELETE',
        path: '/host/providers/anthropic',
        body: { expectedRevision: 'r1' },
      },
    },
    {
      arguments: ['tool-sources', 'remove', 'github'],
      missing: ['tool-sources', 'remove', 'nothing'],
      target: { kind: 'tool source', id: 'github' },
      wouldSend: {
        method: 'DELETE',
        path: '/host/tool-sources/github',
        body: { expectedRevision: 'r2' },
      },
    },
    {
      arguments: ['plugins', 'disable', 'openai'],
      missing: ['plugins', 'disable', 'nothing'],
      target: { kind: 'plugin', id: 'openai' },
      wouldSend: {
        method: 'PUT',
        path: '/host/plugins/openai',
        body: { enabled: false, expectedRevision: 'r3' },
      },
    },
  ];
  for (const scenario of previews) {
    // spawn-free: injected fetch records the requests.
    test(`${scenario.arguments.slice(0, 2).join(' ')} previews the change the CLI would send`, async () => {
      const host = recorder();
      const result = await executeCli(
        [...scenario.arguments, '--dry-run', '--output', 'json', ...url],
        host.dependencies,
      );
      expect(result.exitCode).toBe(0);
      const data = (JSON.parse(result.stdout) as { data: Record<string, unknown> }).data;
      expect(data).toMatchObject({
        dryRun: true,
        previewedBy: 'cli',
        target: scenario.target,
        wouldSend: scenario.wouldSend,
      });
      expect(String(data['note'])).toContain('The CLI made this preview');
      expect(JSON.stringify(data)).not.toContain('secret');
      expect(changes(host)).toEqual([]);

      const absent = recorder();
      const failed = await executeCli(
        [...scenario.missing, '--dry-run', '--output', 'json', ...url],
        absent.dependencies,
      );
      expect(failed.exitCode).toBe(1);
      expect(failed.stderr).toContain('was not found');
      expect(changes(absent)).toEqual([]);
    });
  }

  // spawn-free: injected fetch records the calls.
  test('schedules pause previews from the schedule it reads and pauses nothing', async () => {
    const host = recorder();
    const result = await executeCli(
      [
        'schedules',
        'pause',
        's1',
        '--expected-revision',
        '4',
        '--dry-run',
        '--output',
        'json',
        ...url,
      ],
      host.dependencies,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: {
        dryRun: true,
        previewedBy: 'cli',
        target: { kind: 'schedule', id: 's1' },
        current: { id: 's1', status: 'active' },
        wouldSend: {
          method: 'bureau.schedules.pause',
          params: { scheduleId: 's1', expectedRevision: 4 },
        },
      },
    });
    expect(host.calls.map((call) => call.method)).toEqual(['bureau.schedules.get']);
  });
});

describe('confirmation of the irreversible commands', () => {
  const irreversible = [
    ...SERVER_DRY_RUNS.filter((scenario) => scenario.confirms).map((scenario) => ({
      arguments: scenario.arguments,
      sends: scenario.method,
    })),
    {
      arguments: ['providers', 'disconnect', 'anthropic'],
      sends: 'DELETE /host/providers/anthropic',
    },
    { arguments: ['tool-sources', 'remove', 'github'], sends: 'DELETE /host/tool-sources/github' },
    {
      // `--input -` reads the recorder's stdin, which holds `{"workflowId":"w1"}`.
      arguments: ['api', 'call', 'weft.workflows.cancel', '--input', '-'],
      sends: 'weft.workflows.cancel',
    },
  ];
  const sent = (host: Recorder) => [
    ...host.calls.map((call) => call.method),
    ...host.requests.filter((entry) => entry.startsWith('DELETE ')).map((entry) => entry),
  ];

  for (const scenario of irreversible) {
    const name = scenario.arguments.slice(0, 2).join(' ');
    // spawn-free: injected fetch records the requests; no terminal is present.
    test(`${name} refuses with the usage exit status when input is not a terminal`, async () => {
      const host = recorder();
      const result = await executeCli([...scenario.arguments, ...url], host.dependencies);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('--yes');
      expect(sent(host)).toEqual([]);
    });

    // spawn-free: injected fetch records the requests; the prompt is injected.
    test(`${name} asks on a terminal, and a no changes nothing`, async () => {
      const questions: string[] = [];
      const declined = recorder({
        stdinIsTTY: true,
        prompt: async (question) => {
          questions.push(question);
          return 'n';
        },
      });
      const refused = await executeCli([...scenario.arguments, ...url], declined.dependencies);
      expect(refused.exitCode).toBe(1);
      expect(questions).toHaveLength(1);
      expect(sent(declined)).toEqual([]);

      const agreed = recorder({ stdinIsTTY: true, prompt: async () => 'y' });
      const confirmed = await executeCli([...scenario.arguments, ...url], agreed.dependencies);
      expect(confirmed.exitCode).toBe(0);
      expect(sent(agreed)).toContain(scenario.sends);
    });

    // spawn-free: injected fetch records the requests.
    test(`${name} goes ahead with --yes and refuses --no-input on a terminal`, async () => {
      const host = recorder();
      const result = await executeCli([...scenario.arguments, '--yes', ...url], host.dependencies);
      expect(result.exitCode).toBe(0);
      expect(sent(host)).toContain(scenario.sends);

      const prompts: string[] = [];
      const quiet = recorder({
        stdinIsTTY: true,
        prompt: async (question) => {
          prompts.push(question);
          return 'y';
        },
      });
      const refused = await executeCli(
        [...scenario.arguments, '--no-input', ...url],
        quiet.dependencies,
      );
      expect(refused.exitCode).toBe(2);
      expect(prompts).toEqual([]);
      expect(sent(quiet)).toEqual([]);
    });
  }

  const unconfirmed: ReadonlyArray<{ arguments: readonly string[]; sends: string }> = [
    { arguments: ['runs', 'cancel', 't1', '--kind', 'task'], sends: 'bureau.tasks.cancel' },
    {
      arguments: ['chats', 'cancel', '--task-id', 't1'],
      sends: 'POST /bureau/ag-ui/runs/t1/cancel',
    },
    { arguments: ['goals', 'cancel', 'g1'], sends: 'bureau.goals.cancel' },
    { arguments: ['schedules', 'pause', 's1'], sends: 'bureau.schedules.pause' },
    { arguments: ['plugins', 'disable', 'openai'], sends: 'PUT /host/plugins/openai' },
  ];
  for (const scenario of unconfirmed) {
    // spawn-free: injected fetch records the requests; no terminal is present and no --yes is given.
    test(`${scenario.arguments.slice(0, 2).join(' ')} runs without confirmation`, async () => {
      const host = recorder();
      const result = await executeCli([...scenario.arguments, ...url], host.dependencies);
      expect(result.exitCode).toBe(0);
      expect([
        ...host.calls.map((call) => call.method),
        ...host.requests.filter(
          (entry) => entry.startsWith('POST /bureau/ag-ui') || entry.startsWith('PUT '),
        ),
      ]).toContain(scenario.sends);
    });
  }
});

describe('reviews', () => {
  // spawn-free: nothing runs; arguments are parsed.
  test('no longer declares --yes, which it never read', () => {
    expect(CLI_COMMAND_REGISTRY['reviews']!.options).not.toContain('yes');
    expect(parseCliArguments(['reviews', 'approve', 'r1', '--yes'])).toMatchObject({ exitCode: 2 });
    expect(parseCliArguments(['reviews', 'approve', 'r1'])).toMatchObject({ command: 'reviews' });
  });
});
