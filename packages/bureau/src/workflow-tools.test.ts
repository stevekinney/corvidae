/**
 * COR-1529 — the tools an agent manages its workflows with, run by a real file agent over a real
 * Bureau: which agents are offered them, who they act for (the run's owner of record, with two
 * principals), the identifier a name becomes, every result shape as an ordinary tool result, and
 * the `agent` field of what they write.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createToolbox, readToolShortDescription, type Tool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import { BureauError, createBureau } from './create-bureau';
import { lookupTool } from './testing/agent-file-fixtures.test-support';
import {
  startWorkflowToolsBureau,
  type WorkflowToolsHarness,
} from './testing/workflow-tools-bureau.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';
import {
  createWorkflowTools,
  deriveWorkflowIdentifier,
  WORKFLOW_TOOL_NAMES,
} from './workflow-tools';
import { mayRunAccess } from './run-authority';
import { agentFileDirectory } from './sources/agent-file-directory';
import { nodeAgentFileOperations } from './sources/agent-file-operations';
import { workflowFileDirectory } from './sources/workflow-file-directory';
import { MemoryStorage } from '@lostgradient/storage';
import { createBureauHandler } from './http/create-bureau-handler.ts';
import { authentication, rpc } from './http/management/management-fixtures.test-support.ts';
import {
  contributionCatalog,
  createTickerController,
} from './testing/workflow-contributions.test-support';
import { WORKFLOW_FILE_SIZE_LIMIT } from './workflow-file';
import { waitUntil } from '@lostgradient/testing/wait-until';

const harnesses: WorkflowToolsHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
});

async function start(options?: Parameters<typeof startWorkflowToolsBureau>[0]) {
  const harness = await startWorkflowToolsBureau(options);
  harnesses.push(harness);
  return harness;
}

const TRIGGER = { kind: 'schedule', spec: '1h' };
const STEPS = [
  { kind: 'activity', handler: 'agent', input: { agent: 'scribe', message: 'Write the digest' } },
];

async function fileOf(harness: WorkflowToolsHarness, id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(harness.workflowsPath, `${id}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

async function scheduleStatus(harness: WorkflowToolsHarness): Promise<string | undefined> {
  const detail = await harness.bureau.workflows!.get('digest');
  return detail?.schedule?.status;
}

function hashOf(harness: WorkflowToolsHarness, id: string): string {
  return harness.bureau.workflows!.list().find((entry) => entry.id === id)!.hash!;
}

/** The workflow tools in an offered set: Bureau's own `requestHumanInput` rides beside them. */
function workflowToolsOf(offered: readonly string[] | undefined): string[] {
  return (offered ?? []).filter((name) => name.startsWith('workflows-'));
}

describe('which agents are offered the tools', () => {
  it('offers an agent file the tools it lists, and no others', async () => {
    const harness = await start({ agents: [] });
    await harness.putAgent('lister', ['bureau:workflows-list']);
    await harness.putAgent('bare', []);
    await harness.callTool('bureau__workflows-list', {}, { agent: 'lister' });
    const listerOffered = workflowToolsOf(harness.offered.at(-1));
    // The agent that lists none is offered none, so it makes no call, but its model is still asked.
    const bareCall = await harness.callTool('bureau__workflows-list', {}, { agent: 'bare' });
    expect(bareCall.outcome).not.toBe('success');
    expect(listerOffered).toEqual(['workflows-list']);
    expect(workflowToolsOf(harness.offered.at(-1))).toEqual([]);
  });

  it('names the workflow tools with hyphens, and lists them in the deployment’s tool catalog', async () => {
    expect([...WORKFLOW_TOOL_NAMES]).toEqual([
      'workflows-create',
      'workflows-update',
      'workflows-propose-update',
      'workflows-validate',
      'workflows-catalog',
      'workflows-pause',
      'workflows-resume',
      'workflows-list',
      'workflows-get',
      'workflows-revisions-list',
      'workflows-revisions-get',
      'workflows-start',
      'workflows-signal',
      'workflows-runs-cancel',
      'workflows-runs-list',
      'workflows-runs-get',
      'workflows-runs-history',
    ]);
    const harness = await start();
    await harness.callTool('bureau__workflows-list', {});
    expect(workflowToolsOf(harness.offered[0])).toEqual([...WORKFLOW_TOOL_NAMES].toSorted());
  });

  it('refuses a host tool in the bureau namespace at createBureau, with BAD_REQUEST, in either spelling', async () => {
    for (const name of WORKFLOW_TOOL_NAMES) {
      for (const key of [`bureau:${name}`, `bureau__${name}`]) {
        const error = await createBureau({
          agents: {},
          agentSource: agentFileDirectory('/nonexistent', { tools: { [key]: lookupTool } }),
          workflowSource: workflowFileDirectory('/nonexistent-workflows'),
          models: { generate: () => async () => ({ content: '', toolCalls: [] }) },
          storage: new MemoryStorage(),
          durable: true,
        }).then(
          (bureau) => (bureau.dispose(), undefined),
          (failure: unknown) => failure,
        );
        expect(error, key).toBeInstanceOf(BureauError);
        expect((error as BureauError).code).toBe('BAD_REQUEST');
        expect((error as BureauError).message).toContain(key);
      }
    }
  });

  it('accepts a host tool with the bare name of a workflow tool, with or without a workflow directory', async () => {
    for (const workflowSource of [undefined, workflowFileDirectory('/nonexistent-workflows')]) {
      const bureau = await createBureau({
        agents: {},
        agentSource: agentFileDirectory('/nonexistent', {
          tools: { 'workflows-list': lookupTool },
        }),
        ...(workflowSource === undefined ? {} : { workflowSource }),
        models: { generate: () => async () => ({ content: '', toolCalls: [] }) },
        storage: new MemoryStorage(),
        durable: true,
      });
      await bureau.dispose();
    }
  });
});

describe('deriving an identifier from a name', () => {
  it('lowercases, turns every run of other characters into one hyphen, and trims hyphens', () => {
    for (const [name, id] of [
      ['Nightly Digest', 'nightly-digest'],
      ['  --Hello__World--  ', 'hello-world'],
      ['a   b...c', 'a-b-c'],
      ['Ünï Cödé', 'n-c-d'],
      ['x', 'x'],
      ['digest 2', 'digest-2'],
    ] as const) {
      expect(deriveWorkflowIdentifier(name), name).toEqual({ id });
    }
  });

  it('refuses a name with nothing to make an identifier from, one that starts with a digit, and one that is too long', () => {
    for (const name of ['', '   ', '!!!', '日本語', '2nd digest', '-9']) {
      expect(deriveWorkflowIdentifier(name), name).toHaveProperty('message');
    }
    expect(deriveWorkflowIdentifier('a'.repeat(64))).toEqual({ id: 'a'.repeat(64) });
    expect(deriveWorkflowIdentifier('a'.repeat(65))).toHaveProperty('message');
  });
});

describe('workflows-create', () => {
  it('writes a file owned by the calling agent, active as the call returns, and derives the identifier', async () => {
    const harness = await start();

    const { result, outcome } = await harness.callTool('bureau__workflows-create', {
      name: 'Nightly Digest!',
      trigger: TRIGGER,
      steps: STEPS,
    });

    expect(outcome).toBe('success');
    const hash = hashOf(harness, 'nightly-digest');
    expect(result).toEqual({ status: 'ok', id: 'nightly-digest', hash });
    expect(await fileOf(harness, 'nightly-digest')).toMatchObject({
      name: 'nightly-digest',
      agent: 'scribe',
      trigger: TRIGGER,
    });
    // Active at once: registered with the engine, and its schedule exists and runs.
    const detail = await harness.bureau.workflows!.get('nightly-digest');
    expect(detail?.state).toBe('ready');
    expect(detail?.schedule?.status).toBe('active');
  });

  it('writes the description it is given, and none when it is left out', async () => {
    const harness = await start();

    await harness.callTool('bureau__workflows-create', {
      name: 'Described',
      description: 'Writes the nightly digest.',
      trigger: TRIGGER,
      steps: STEPS,
    });
    await harness.callTool('bureau__workflows-create', {
      name: 'Bare',
      trigger: TRIGGER,
      steps: STEPS,
    });

    expect(await fileOf(harness, 'described')).toMatchObject({
      description: 'Writes the nightly digest.',
    });
    expect(await fileOf(harness, 'bare')).not.toHaveProperty('description');
    expect(harness.bureau.workflows!.list().map((listing) => listing.description)).toEqual([
      null,
      'Writes the nightly digest.',
    ]);
  });

  it('takes an explicit identifier, and answers a taken one as a conflict naming it, with no suffix', async () => {
    const harness = await start();
    const first = await harness.callTool('bureau__workflows-create', {
      name: 'Anything',
      id: 'digest',
      trigger: TRIGGER,
      steps: STEPS,
    });
    expect(first.result).toMatchObject({ status: 'ok', id: 'digest' });

    const taken = await harness.callTool('bureau__workflows-create', {
      name: 'Digest',
      trigger: TRIGGER,
      steps: STEPS,
    });
    expect(taken.outcome).toBe('success');
    expect(taken.result).toMatchObject({
      status: 'conflict',
      id: 'digest',
      reason: 'workflow-file-exists',
    });
    expect(harness.bureau.workflows!.list().map((entry) => entry.id)).toEqual(['digest']);
  });

  it('answers a name that cannot be an identifier as invalid-identifier, and writes nothing', async () => {
    const harness = await start();
    for (const name of ['!!!', '9 lives', 'x'.repeat(65)]) {
      const { result, outcome } = await harness.callTool('bureau__workflows-create', {
        name,
        trigger: TRIGGER,
        steps: STEPS,
      });
      expect(outcome, name).toBe('success');
      expect(result, name).toMatchObject({ status: 'invalid', code: 'invalid-identifier' });
    }
    expect(harness.bureau.workflows!.list()).toEqual([]);
  });

  it('answers an explicit identifier that is not valid as invalid-identifier', async () => {
    const harness = await start();
    const { result } = await harness.callTool('bureau__workflows-create', {
      name: 'Digest',
      id: 'Bad_Id',
      trigger: TRIGGER,
      steps: STEPS,
    });
    expect(result).toMatchObject({ status: 'invalid', code: 'invalid-identifier' });
    expect(harness.bureau.workflows!.list()).toEqual([]);
  });

  it('answers a document that would not load with its issues as the tool result, not as a failure', async () => {
    const harness = await start();
    const { result, outcome } = await harness.callTool('bureau__workflows-create', {
      name: 'Broken',
      trigger: { kind: 'schedule', spec: 'not a schedule' },
      steps: [{ kind: 'activity', handler: 'nobody' }],
    });
    expect(outcome).toBe('success');
    expect(result).toMatchObject({ status: 'invalid', code: 'invalid-document' });
    const issues = (result as { issues: Array<{ path: string; message: string }> }).issues;
    expect(issues.map((issue) => issue.path).toSorted()).toEqual(['steps[0].handler', 'trigger']);
    expect(harness.bureau.workflows!.list()).toEqual([]);
  });

  it('creates a workflow that is paused when it says so, and a signal-triggered one', async () => {
    const harness = await start();
    await harness.callTool('bureau__workflows-create', {
      name: 'Listener',
      trigger: { kind: 'signal', name: 'go' },
      steps: STEPS,
      paused: true,
    });
    expect(harness.bureau.workflows!.list()[0]).toMatchObject({
      id: 'listener',
      paused: true,
      triggerKind: 'signal',
    });
  });
});

describe('what a model is shown of a tool’s input', () => {
  // The providers build their requests through the toolbox's adapters, which read each tool's
  // `input` schema; a tool's own `toJSON()` is not what a model sees.
  const tools = () =>
    createToolbox(
      Object.values(
        createWorkflowTools({
          workflows: () => undefined,
          runIdentity: async () => ({ agent: undefined, owner: undefined }),
        }),
      ),
    );

  it.each([
    ['workflows-create', ['name', 'trigger', 'steps']],
    ['workflows-update', ['id', 'expectedHash', 'trigger', 'steps']],
    ['workflows-propose-update', ['id', 'expectedHash', 'trigger', 'steps']],
    ['workflows-pause', ['id', 'expectedHash']],
    ['workflows-resume', ['id', 'expectedHash']],
  ] as const)(
    'is the real schema for %s, through both provider adapters',
    async (name, required) => {
      const anthropicTools = await tools().toAnthropicTools();
      const openaiTools = await tools().toOpenAITools();
      const anthropic = anthropicTools.find((tool) => tool.name === name);
      const openai = openaiTools.find((tool) => tool.function.name === name);
      expect(anthropic?.input_schema).toMatchObject({
        required: expect.arrayContaining([...required]),
      });
      expect(openai?.function.parameters).toMatchObject({
        required: expect.arrayContaining([...required]),
      });
    },
  );
});

describe('workflows-get and workflow revisions', () => {
  it('proposes a validated revision without writing it and rejects stale or invalid proposals', async () => {
    const harness = await start();
    await harness.callTool('bureau__workflows-create', {
      name: 'Digest',
      trigger: TRIGGER,
      steps: STEPS,
    });
    const before = await readFile(join(harness.workflowsPath, 'digest.json'), 'utf8');
    const hash = hashOf(harness, 'digest');
    const proposal = await harness.callTool('bureau__workflows-propose-update', {
      id: 'digest',
      expectedHash: hash,
      trigger: { kind: 'signal', name: 'approved' },
      steps: [{ ...STEPS[0], title: 'Write the revised digest' }],
    });
    expect(proposal.result).toMatchObject({ status: 'ok', id: 'digest', baseHash: hash });
    expect((proposal.result as { proposedText: string }).proposedText).toContain('approved');
    expect(await readFile(join(harness.workflowsPath, 'digest.json'), 'utf8')).toBe(before);

    const invalid = await harness.callTool('bureau__workflows-propose-update', {
      id: 'digest',
      expectedHash: hash,
      trigger: { kind: 'webhook' },
      steps: STEPS,
    });
    expect(invalid.result).toMatchObject({ status: 'invalid', code: 'invalid-document' });
    expect(await readFile(join(harness.workflowsPath, 'digest.json'), 'utf8')).toBe(before);

    await harness.callTool('bureau__workflows-update', {
      id: 'digest',
      expectedHash: hash,
      trigger: { kind: 'schedule', spec: '2h' },
      steps: STEPS,
    });
    const stale = await harness.callTool('bureau__workflows-propose-update', {
      id: 'digest',
      expectedHash: hash,
      trigger: TRIGGER,
      steps: STEPS,
    });
    expect(stale.result).toMatchObject({
      status: 'conflict',
      id: 'digest',
      reason: 'workflow-file-changed',
      currentHash: hashOf(harness, 'digest'),
    });
  });

  it('reads a workflow and updates it with the returned hash', async () => {
    const harness = await start();
    await harness.callTool('bureau__workflows-create', {
      name: 'Digest',
      trigger: TRIGGER,
      steps: STEPS,
    });
    const read = await harness.callTool('bureau__workflows-get', { id: 'digest' });
    expect(read.result).toMatchObject({ status: 'ok', id: 'digest', document: { name: 'digest' } });
    const result = await harness.callTool('bureau__workflows-update', {
      id: 'digest',
      expectedHash: (read.result as { hash: string }).hash,
      trigger: { kind: 'schedule', spec: '2h' },
      steps: STEPS,
    });
    expect(result.result).toMatchObject({ status: 'ok', id: 'digest' });
  });

  it('reads an invalid file and repairs it with its hash', async () => {
    const harness = await start();
    await Bun.write(join(harness.workflowsPath, 'digest.json'), '{"trigger":{"kind":"bad"}}');
    await harness.bureau.workflows!.refresh();
    const read = await harness.callTool('bureau__workflows-get', { id: 'digest' });
    expect(read.result).toMatchObject({
      status: 'invalid',
      id: 'digest',
      text: '{"trigger":{"kind":"bad"}}',
    });
    expect((read.result as { hash: string }).hash).toHaveLength(64);
    const result = await harness.callTool('bureau__workflows-update', {
      id: 'digest',
      expectedHash: (read.result as { hash: string }).hash,
      trigger: TRIGGER,
      steps: STEPS,
    });
    expect(result.result).toMatchObject({ status: 'ok', id: 'digest' });
  });

  it('reads one coherent snapshot when an external edit arrives without a watcher refresh', async () => {
    const harness = await start();
    await harness.callTool('bureau__workflows-create', {
      name: 'Digest',
      trigger: TRIGGER,
      steps: STEPS,
    });
    await Bun.write(join(harness.workflowsPath, 'digest.json'), '{"trigger":{"kind":"bad"}}');

    const read = await harness.callTool('bureau__workflows-get', { id: 'digest' });
    expect(read.result).toMatchObject({
      status: 'invalid',
      id: 'digest',
      text: '{"trigger":{"kind":"bad"}}',
      code: 'invalid-document',
    });
    expect(read.result).not.toHaveProperty('document');
  });

  it('returns an invalid hash and explanation when external bytes are not UTF-8', async () => {
    const harness = await start();
    await harness.callTool('bureau__workflows-create', {
      name: 'Digest',
      trigger: TRIGGER,
      steps: STEPS,
    });
    await Bun.write(join(harness.workflowsPath, 'digest.json'), new Uint8Array([0xff]));

    const read = await harness.callTool('bureau__workflows-get', { id: 'digest' });
    expect(read.result).toMatchObject({ status: 'invalid', id: 'digest', code: 'not-utf8' });
    expect(read.result).toHaveProperty('hash');
    expect(read.result).toMatchObject({
      issues: [{ path: '$', message: 'The file is not valid UTF-8.' }],
    });
  });

  it('returns invalid details for an externally written identifier that cannot be loaded', async () => {
    const harness = await start();
    await Bun.write(join(harness.workflowsPath, 'Bad_Name.json'), workflowFileText('Bad_Name'));

    const read = await harness.callTool('bureau__workflows-get', { id: 'Bad_Name' });
    expect(read.result).toMatchObject({
      status: 'invalid',
      id: 'Bad_Name',
      code: 'invalid-identifier',
    });
  });

  it('reports oversized and unreadable registered workflow files without hash or text', async () => {
    const harness = await start({
      workflowOperations: {
        ...nodeAgentFileOperations,
        read: async (path) => {
          if (path.endsWith('locked.json')) throw new Error('EACCES: permission denied');
          return nodeAgentFileOperations.read(path);
        },
      },
    });
    await Bun.write(
      join(harness.workflowsPath, 'huge.json'),
      'x'.repeat(WORKFLOW_FILE_SIZE_LIMIT + 1),
    );
    await Bun.write(join(harness.workflowsPath, 'locked.json'), workflowFileText('locked'));

    for (const [id, code] of [
      ['huge', 'file-too-large'],
      ['locked', 'unreadable'],
    ] as const) {
      const read = await harness.callTool('bureau__workflows-get', { id });
      expect(read.result).toMatchObject({ status: 'invalid', id, code });
      expect(read.result).not.toHaveProperty('hash');
      expect(read.result).not.toHaveProperty('text');
      expect(read.result).not.toHaveProperty('document');
    }
  });

  it('preserves activity-version pins in workflow and revision documents', async () => {
    const ticker = createTickerController();
    const harness = await start({
      overrides: { contributionCatalog: contributionCatalog({ activityVersion: '1', ticker }) },
    });
    await Bun.write(
      join(harness.workflowsPath, 'pipeline.json'),
      workflowFileText('pipeline', {
        trigger: { kind: 'x:ticker', channel: 'alerts' },
        steps: [{ kind: 'activity', handler: 'x:y', input: 'hello' }],
      }),
    );
    await harness.bureau.workflows!.refresh();
    const detail = await harness.callTool('bureau__workflows-get', { id: 'pipeline' });
    expect(detail.result).toMatchObject({
      status: 'ok',
      document: { activityVersions: { 'x:y': '1' } },
    });

    const run = await harness.bureau
      .durableEngine()!
      .start('pipeline', null, { id: 'pipeline-run' });
    await ticker.fire(null);
    await run.result();
    const listed = await harness.callTool('bureau__workflows-revisions-list', { id: 'pipeline' });
    const revision = (listed.result as { revisions: Array<{ workflowVersion: string }> })
      .revisions[0];
    const revisionDetail = await harness.callTool('bureau__workflows-revisions-get', {
      id: 'pipeline',
      workflowVersion: revision!.workflowVersion,
    });
    expect(revisionDetail.result).toMatchObject({
      status: 'ok',
      document: { activityVersions: { 'x:y': '1' } },
    });
  });

  it('shares definitions with members but keeps revision usage private from administrators', async () => {
    const harness = await start({
      overrides: {
        workspace: {
          workspaceId: 'workspace-a',
          resolveMembership: async ({ subject }) => ({
            version: 1,
            workspaceId: 'workspace-a',
            actorId: subject ?? 'unknown',
            actorKind: 'user',
            owner: `api-key:${subject ?? 'unknown'}`,
            membershipRevision: 'revision-1',
            capabilities: ['workspace:use', 'workspace:manage'],
          }),
          resolveOwnerMembership: async (owner) => ({
            version: 1,
            workspaceId: 'workspace-a',
            actorId: owner,
            actorKind: 'user',
            owner,
            membershipRevision: 'revision-1',
            capabilities:
              owner === 'owner-admin' ? ['workspace:use', 'workspace:manage'] : ['workspace:use'],
          }),
        },
      },
    });
    await harness.callTool(
      'bureau__workflows-create',
      { name: 'Digest', trigger: TRIGGER, steps: STEPS },
      { principal: 'owner-admin' },
    );
    const listed = await harness.callTool(
      'bureau__workflows-list',
      {},
      { principal: 'owner-member' },
    );
    expect(listed.result).toMatchObject({ status: 'ok', workflows: [{ id: 'digest' }] });
    const refused = await harness.callTool(
      'bureau__workflows-update',
      { id: 'digest', expectedHash: hashOf(harness, 'digest'), trigger: TRIGGER, steps: STEPS },
      { principal: 'owner-member' },
    );
    expect(refused.result).toMatchObject({ status: 'not-found' });
    const run = await harness.bureau.workflows!.start('digest', { owner: 'owner-member' });
    await harness.bureau.durableEngine()!.getHandle(run.runId).result();
    const member = await harness.callTool(
      'bureau__workflows-revisions-list',
      { id: 'digest' },
      { principal: 'owner-member' },
    );
    expect(member.result).toMatchObject({
      status: 'ok',
      revisions: [expect.objectContaining({ workflowVersion: expect.any(String) })],
    });
    const administrator = await harness.callTool(
      'bureau__workflows-revisions-list',
      { id: 'digest' },
      { principal: 'owner-admin' },
    );
    expect(administrator.result).toMatchObject({ status: 'ok', revisions: [] });
  });

  it('lists and reads the revisions that have run', async () => {
    const harness = await start();
    await harness.callTool('bureau__workflows-create', {
      name: 'Digest',
      trigger: TRIGGER,
      steps: STEPS,
    });
    const first = await harness.bureau.durableEngine()!.start('digest', null, { id: 'first-run' });
    await first.result();
    await harness.callTool('bureau__workflows-update', {
      id: 'digest',
      expectedHash: hashOf(harness, 'digest'),
      trigger: { kind: 'schedule', spec: '2h' },
      steps: STEPS,
    });
    const second = await harness.bureau
      .durableEngine()!
      .start('digest', null, { id: 'second-run' });
    await second.result();
    const listed = await harness.callTool('bureau__workflows-revisions-list', { id: 'digest' });
    const revisions = (listed.result as { revisions: Array<{ workflowVersion: string }> })
      .revisions;
    expect(revisions).toHaveLength(2);
    const read = await harness.callTool('bureau__workflows-revisions-get', {
      id: 'digest',
      workflowVersion: revisions[0]!.workflowVersion,
    });
    expect(read.result).toMatchObject({
      status: 'ok',
      workflowVersion: revisions[0]!.workflowVersion,
    });
  });

  it('hides reads from a2a and reports owner misses with their distinct shapes', async () => {
    const harness = await start();
    await harness.callTool('bureau__workflows-create', {
      name: 'Digest',
      trigger: TRIGGER,
      steps: STEPS,
    });
    for (const [tool, input] of [
      ['workflows-get', { id: 'digest' }],
      ['workflows-revisions-get', { id: 'digest', workflowVersion: 'missing' }],
    ] as const) {
      const result = await harness.callTool(`bureau__${tool}`, input, { principal: 'api-key:a2a' });
      expect(result.result, tool).toEqual({ status: 'not-found', id: 'digest' });
    }
    const hiddenRevisions = await harness.callTool(
      'bureau__workflows-revisions-list',
      { id: 'digest' },
      { principal: 'api-key:a2a' },
    );
    expect(hiddenRevisions.result).toEqual({ status: 'ok', revisions: [] });
    for (const [tool, input] of [
      ['workflows-get', { id: 'missing' }],
      ['workflows-revisions-list', { id: 'missing' }],
      ['workflows-revisions-get', { id: 'missing', workflowVersion: 'missing' }],
    ] as const) {
      const missing = await harness.callTool(`bureau__${tool}`, input);
      expect(missing.result, tool).toEqual({
        status: 'not-found',
        id: 'missing',
      });
    }
  });
});

describe('workflows-update, workflows-pause, workflows-resume', () => {
  async function seeded() {
    const harness = await start({ agents: ['scribe', 'editor'] });
    await harness.callTool('bureau__workflows-create', {
      name: 'Digest',
      trigger: TRIGGER,
      steps: STEPS,
    });
    return harness;
  }

  it('update replaces the definition and makes the caller the agent that wrote it', async () => {
    const harness = await seeded();
    const { result } = await harness.callTool(
      'bureau__workflows-update',
      {
        id: 'digest',
        expectedHash: hashOf(harness, 'digest'),
        trigger: { kind: 'schedule', spec: '2h' },
        steps: STEPS,
      },
      { agent: 'editor' },
    );
    expect(result).toEqual({ status: 'ok', id: 'digest', hash: hashOf(harness, 'digest') });
    expect(await fileOf(harness, 'digest')).toMatchObject({
      agent: 'editor',
      trigger: { kind: 'schedule', spec: '2h' },
    });
    expect(await scheduleStatus(harness)).toBe('active');
  });

  it('pause and resume change only paused, and leave the agent that wrote the file', async () => {
    const harness = await seeded();
    const before = await fileOf(harness, 'digest');

    const paused = await harness.callTool(
      'bureau__workflows-pause',
      { id: 'digest', expectedHash: hashOf(harness, 'digest') },
      { agent: 'editor' },
    );
    expect(paused.result).toMatchObject({ status: 'ok', id: 'digest' });
    expect(await fileOf(harness, 'digest')).toEqual({ ...before, paused: true });
    expect(await scheduleStatus(harness)).toBe('paused');

    const resumed = await harness.callTool(
      'bureau__workflows-resume',
      { id: 'digest', expectedHash: hashOf(harness, 'digest') },
      { agent: 'editor' },
    );
    expect(resumed.result).toMatchObject({ status: 'ok', id: 'digest' });
    expect(await fileOf(harness, 'digest')).toEqual({ ...before, paused: false });
    expect(await scheduleStatus(harness)).toBe('active');
  });

  it('answers a stale expectedHash as a conflict that names the identifier and the hash now on disk', async () => {
    const harness = await seeded();
    const stale = hashOf(harness, 'digest');
    await harness.bureau.workflows!.update(
      'digest',
      { agent: 'scribe', trigger: { kind: 'schedule', spec: '3h' }, steps: STEPS },
      { expectedHash: stale },
    );
    const current = hashOf(harness, 'digest');
    for (const [tool, args] of [
      ['workflows-update', { trigger: TRIGGER, steps: STEPS }],
      ['workflows-pause', {}],
      ['workflows-resume', {}],
    ] as const) {
      const { result, outcome } = await harness.callTool(`bureau__${tool}`, {
        id: 'digest',
        expectedHash: stale,
        ...args,
      });
      expect(outcome, tool).toBe('success');
      expect(result, tool).toEqual({
        status: 'conflict',
        id: 'digest',
        reason: 'workflow-file-changed',
        currentHash: current,
      });
    }
    expect(hashOf(harness, 'digest')).toBe(current);
  });

  it('answers a workflow that does not exist as not-found', async () => {
    const harness = await start();
    for (const [tool, args] of [
      ['workflows-update', { trigger: TRIGGER, steps: STEPS }],
      ['workflows-pause', {}],
      ['workflows-resume', {}],
    ] as const) {
      const { result } = await harness.callTool(`bureau__${tool}`, {
        id: 'nobody',
        expectedHash: 'abc',
        ...args,
      });
      expect(result, tool).toEqual({ status: 'not-found', id: 'nobody' });
    }
  });

  it('answers an update that would not load as invalid, and leaves the file as it was', async () => {
    const harness = await seeded();
    const before = await readFile(join(harness.workflowsPath, 'digest.json'), 'utf8');
    const { result } = await harness.callTool('bureau__workflows-update', {
      id: 'digest',
      expectedHash: hashOf(harness, 'digest'),
      trigger: { kind: 'webhook' },
      steps: STEPS,
    });
    expect(result).toMatchObject({ status: 'invalid', code: 'invalid-document' });
    expect(await readFile(join(harness.workflowsPath, 'digest.json'), 'utf8')).toBe(before);
  });
});

describe('workflows-validate and workflows-catalog', () => {
  it('validates a draft without writing or registering it, and reports the same issues as update', async () => {
    const harness = await start();
    const before = harness.bureau.workflows!.list();
    const invalid = await harness.callTool('bureau__workflows-validate', {
      id: 'draft',
      trigger: { kind: 'schedule', spec: 'not a schedule' },
      steps: [{ kind: 'activity', handler: 'missing' }],
    });
    expect(invalid.result).toMatchObject({ status: 'invalid', code: 'invalid-document' });
    expect(harness.bureau.workflows!.list()).toEqual(before);

    const valid = await harness.callTool('bureau__workflows-validate', {
      id: 'draft',
      trigger: TRIGGER,
      steps: STEPS,
    });
    expect(valid.result).toMatchObject({ status: 'ok', id: 'draft' });
    expect(harness.bureau.workflows!.list()).toEqual(before);
  });

  it('retains undeclared draft keys so validation agrees with the strict HTTP operation', async () => {
    const harness = await start();
    const before = harness.bureau.workflows!.list();
    const definition = {
      trigger: TRIGGER,
      steps: STEPS,
      retries: 3,
    };
    const tool = await harness.callTool('bureau__workflows-validate', {
      id: 'draft',
      ...definition,
    });
    const http = await rpc(
      createBureauHandler(harness.bureau, { authentication }),
      'bureau.workflows.validate',
      { id: 'draft', definition },
      'workflows-reader-key',
    );
    expect(tool.result).toMatchObject({ status: 'invalid', code: 'invalid-document' });
    expect(tool.result).toMatchObject({
      issues: [expect.objectContaining({ path: '', message: expect.stringContaining('retries') })],
    });
    expect(http.result as Record<string, unknown>).toEqual(tool.result as Record<string, unknown>);
    expect(harness.bureau.workflows!.list()).toEqual(before);
  });

  it('shares undeclared-key validation across create and update, without changing stored state', async () => {
    const harness = await start();
    const created = await harness.callTool('bureau__workflows-create', {
      name: 'Digest',
      trigger: TRIGGER,
      steps: STEPS,
    });
    expect(created.result).toMatchObject({ status: 'ok', id: 'digest' });
    const before = hashOf(harness, 'digest');

    const update = await harness.callTool('bureau__workflows-update', {
      id: 'digest',
      expectedHash: before,
      trigger: TRIGGER,
      steps: STEPS,
      retries: 3,
    });
    expect(update.result).toMatchObject({ status: 'invalid', code: 'invalid-document' });
    expect(hashOf(harness, 'digest')).toBe(before);

    const create = await harness.callTool('bureau__workflows-create', {
      name: 'New draft',
      trigger: TRIGGER,
      steps: STEPS,
      retries: 3,
    });
    expect(create.result).toMatchObject({ status: 'invalid', code: 'invalid-document' });
    expect(harness.bureau.workflows!.list().map((entry) => entry.id)).toEqual(['digest']);
  });

  it('derives the catalog step kinds from Weft and includes the built-in activity and triggers', async () => {
    const harness = await start();
    const { result } = await harness.callTool('bureau__workflows-catalog', {});
    expect(result).toMatchObject({ status: 'ok' });
    const catalog = result as {
      stepKinds: { kind: string }[];
      activities: { id: string }[];
      triggerKinds: { id: string; configuration: Record<string, unknown> | null }[];
    };
    expect(catalog.stepKinds.map(({ kind }) => kind)).toEqual([
      'activity',
      'sleep',
      'await-signal',
      'branch',
    ]);
    expect(catalog.activities.map(({ id }) => id)).toContain('agent');
    expect(catalog.triggerKinds.map(({ id }) => id)).toEqual(['schedule', 'signal', 'manual']);
    expect(catalog.triggerKinds[0]?.configuration).toMatchObject({
      required: ['spec'],
      additionalProperties: false,
    });
    expect(catalog.triggerKinds[1]?.configuration).toMatchObject({
      required: ['name'],
      additionalProperties: false,
    });

    const missing = await harness.callTool('bureau__workflows-validate', {
      id: 'missing-schedule',
      trigger: { kind: 'schedule' },
      steps: STEPS,
    });
    expect(missing.result).toMatchObject({ status: 'invalid' });
    const extra = await harness.callTool('bureau__workflows-validate', {
      id: 'extra-signal',
      trigger: { kind: 'signal', name: 'go', retries: 3 },
      steps: STEPS,
    });
    expect(extra.result).toMatchObject({ status: 'invalid' });
  });
});

describe('workflows-list', () => {
  it('lists each workflow with its hash, state, paused, and trigger kind, and a broken file with its problem', async () => {
    const harness = await start();
    await harness.callTool('bureau__workflows-create', {
      name: 'Digest',
      trigger: TRIGGER,
      steps: STEPS,
    });
    await harness.callTool('bureau__workflows-create', {
      name: 'Listener',
      trigger: { kind: 'signal', name: 'go' },
      steps: STEPS,
      paused: true,
    });
    await Bun.write(join(harness.workflowsPath, 'broken.json'), '{ not json');
    await harness.bureau.workflows!.refresh();

    const { result } = await harness.callTool('bureau__workflows-list', {});

    expect(result).toEqual({
      status: 'ok',
      workflows: [
        {
          id: 'broken',
          hash: hashOf(harness, 'broken'),
          state: 'invalid',
          paused: false,
          triggerKind: null,
          title: null,
          description: null,
          inputSchema: null,
          outputSchema: null,
          problem: 'invalid-json',
        },
        {
          id: 'digest',
          hash: hashOf(harness, 'digest'),
          state: 'ready',
          paused: false,
          triggerKind: 'schedule',
          title: null,
          description: null,
          inputSchema: null,
          outputSchema: null,
          problem: null,
        },
        {
          id: 'listener',
          hash: hashOf(harness, 'listener'),
          state: 'ready',
          paused: true,
          triggerKind: 'signal',
          title: null,
          description: null,
          inputSchema: null,
          outputSchema: null,
          problem: null,
        },
      ],
    });
  });

  it('lists the description, so an agent can pass it back and keep it through an update', async () => {
    const harness = await start();
    await harness.callTool('bureau__workflows-create', {
      name: 'Digest',
      description: 'Writes the daily digest.',
      trigger: TRIGGER,
      steps: STEPS,
    });
    const listing = await harness.callTool('bureau__workflows-list', {});
    const listed = listing.result as {
      workflows: Array<{ id: string; hash: string; description: string | null }>;
    };
    expect(listed.workflows).toMatchObject([
      { id: 'digest', description: 'Writes the daily digest.' },
    ]);

    const { result } = await harness.callTool('bureau__workflows-update', {
      id: 'digest',
      expectedHash: listed.workflows[0]!.hash,
      description: listed.workflows[0]!.description,
      trigger: TRIGGER,
      steps: STEPS,
    });
    expect(result).toMatchObject({ status: 'ok' });
    const afterListing = await harness.callTool('bureau__workflows-list', {});
    const after = afterListing.result as {
      workflows: Array<{ description: string | null }>;
    };
    expect(after.workflows[0]?.description).toBe('Writes the daily digest.');
  });

  it('tells the model that an update replaces the whole definition, description included', () => {
    const tools = createWorkflowTools({
      workflows: () => undefined,
      runIdentity: async () => ({ agent: undefined, owner: undefined }),
    });
    expect(tools['workflows-update']?.description).toContain('description and schemas included');
    expect(tools['workflows-list']?.description).toContain('description');
  });

  it('writes the schemas it is given, lists them, and drops them when an update leaves them out', async () => {
    const harness = await start();
    const inputSchema = { type: 'object', required: ['city'] };
    const outputSchema = { type: 'object' };

    await harness.callTool('bureau__workflows-create', {
      name: 'Digest',
      trigger: { kind: 'signal', name: 'go' },
      steps: STEPS,
      inputSchema,
      outputSchema,
    });

    expect(await fileOf(harness, 'digest')).toMatchObject({ inputSchema, outputSchema });
    const listed = await harness.callTool('bureau__workflows-list', {});
    expect(listed.result).toMatchObject({
      workflows: [{ id: 'digest', inputSchema, outputSchema }],
    });
    // An update that passes the listed schemas back keeps them; one that leaves them out has none.
    const kept = await harness.callTool('bureau__workflows-update', {
      id: 'digest',
      expectedHash: hashOf(harness, 'digest'),
      trigger: { kind: 'signal', name: 'go' },
      steps: STEPS,
      inputSchema,
      outputSchema,
    });
    expect(kept.result).toMatchObject({ status: 'ok' });
    expect(harness.bureau.workflows!.list()[0]?.inputSchema).toEqual(inputSchema);
    await harness.callTool('bureau__workflows-update', {
      id: 'digest',
      expectedHash: hashOf(harness, 'digest'),
      trigger: { kind: 'signal', name: 'go' },
      steps: STEPS,
    });
    expect(await fileOf(harness, 'digest')).not.toHaveProperty('inputSchema');
  });

  it('refuses a schema outside the answer-schema limits as an invalid document naming the field', async () => {
    const harness = await start();

    const { result } = await harness.callTool('bureau__workflows-create', {
      name: 'Digest',
      trigger: { kind: 'signal', name: 'go' },
      steps: STEPS,
      inputSchema: { type: 'string', pattern: '^a' },
    });

    expect(result).toMatchObject({ status: 'invalid', code: 'invalid-document' });
    expect(JSON.stringify(result)).toContain('inputSchema');
    expect(harness.bureau.workflows!.list()).toEqual([]);
  });

  it('hands the hash it lists to the tools that change a file', async () => {
    const harness = await start();
    await harness.callTool('bureau__workflows-create', {
      name: 'Digest',
      trigger: TRIGGER,
      steps: STEPS,
    });
    const called = await harness.callTool('bureau__workflows-list', {});
    const listed = called.result as { workflows: Array<{ id: string; hash: string }> };
    const { result } = await harness.callTool('bureau__workflows-pause', {
      id: 'digest',
      expectedHash: listed.workflows[0]!.hash,
    });
    expect(result).toMatchObject({ status: 'ok' });
  });
});

describe('who the tools act for', () => {
  async function withWorkflow() {
    const harness = await start();
    await harness.callTool('bureau__workflows-create', {
      name: 'Digest',
      trigger: TRIGGER,
      steps: STEPS,
    });
    return harness;
  }

  it('lists nothing and answers every write as not-found for a run another principal owns, and changes nothing', async () => {
    const harness = await withWorkflow();
    const principal = 'api-key:alice';
    const before = await readFile(join(harness.workflowsPath, 'digest.json'), 'utf8');
    const hash = hashOf(harness, 'digest');

    const listed = await harness.callTool('bureau__workflows-list', {}, { principal });
    expect(listed.outcome).toBe('success');
    expect(listed.result).toEqual({ status: 'ok', workflows: [] });

    for (const [tool, args, id] of [
      ['workflows-create', { name: 'Intruder', trigger: TRIGGER, steps: STEPS }, 'intruder'],
      [
        'workflows-update',
        { id: 'digest', expectedHash: hash, trigger: TRIGGER, steps: STEPS },
        'digest',
      ],
      ['workflows-pause', { id: 'digest', expectedHash: hash }, 'digest'],
      ['workflows-resume', { id: 'digest', expectedHash: hash }, 'digest'],
    ] as const) {
      const { result, outcome } = await harness.callTool(`bureau__${tool}`, args, { principal });
      expect(outcome, tool).toBe('success');
      expect(result, tool).toEqual({ status: 'not-found', id });
    }

    expect(await readFile(join(harness.workflowsPath, 'digest.json'), 'utf8')).toBe(before);
    expect(harness.bureau.workflows!.list().map((entry) => entry.id)).toEqual(['digest']);
  });

  it('acts for a run whose owner of record is the deployment’s, and not for one that merely says so', async () => {
    const harness = await withWorkflow();
    // `anonymous:local` is the deployment's owner of record: the default for a run with no principal,
    // and also what an explicit principal of that name is.
    const asOwner = await harness.callTool(
      'bureau__workflows-list',
      {},
      { principal: 'anonymous:local' },
    );
    expect((asOwner.result as { workflows: unknown[] }).workflows).toHaveLength(1);
    const asDefault = await harness.callTool('bureau__workflows-list', {});
    expect((asDefault.result as { workflows: unknown[] }).workflows).toHaveLength(1);
  });

  it('answers a call made with no run behind it as not-found', async () => {
    const harness = await withWorkflow();
    const tools = createWorkflowTools({
      workflows: () => harness.bureau.workflows,
      runIdentity: async () => ({ agent: 'scribe', owner: harness.bureau.workflows!.owner }),
    });
    const answer = await (
      tools['workflows-list'] as unknown as {
        execute: (input: unknown, context: unknown) => Promise<unknown>;
      }
    ).execute({}, {});
    expect(answer).toEqual({ status: 'ok', workflows: [] });
  });

  it('keeps the run tools owner-only, with an empty signal response for a foreign A2A caller', async () => {
    const foreign = await withWorkflow();
    const principal = { principal: 'api-key:a2a' } as const;
    const listCall = await foreign.callTool('bureau__workflows-list', {}, principal);
    expect(listCall.result).toEqual({
      status: 'ok',
      workflows: [],
    });
    const signalCall = await foreign.callTool(
      'bureau__workflows-signal',
      { name: 'go' },
      principal,
    );
    expect(signalCall.result).toEqual({ status: 'ok', started: [], delivered: [], rejected: [] });
    const startCall = await foreign.callTool(
      'bureau__workflows-start',
      { id: 'digest' },
      principal,
    );
    expect(startCall.result).toEqual({ status: 'not-found', id: 'digest' });
    for (const tool of [
      'workflows-runs-list',
      'workflows-runs-get',
      'workflows-runs-cancel',
      'workflows-runs-history',
    ] as const) {
      const input = tool === 'workflows-runs-list' ? {} : { runId: 'missing-run' };
      const call = await foreign.callTool(`bureau__${tool}`, input, principal);
      expect(call.result, tool).toEqual(
        tool === 'workflows-runs-list'
          ? { status: 'ok', runs: [], nextOffset: null }
          : { status: 'not-found', id: 'missing-run' },
      );
    }
  });

  it('keeps workflow tools owner-only when the shared authority has local operator scopes', () => {
    expect(
      mayRunAccess('anonymous:local', 'bureau.workflows:read', 'library:custom', {
        allowOperatorScope: false,
      }),
    ).toBe(false);
    expect(
      mayRunAccess('library:custom', 'bureau.workflows:write', 'library:custom', {
        allowOperatorScope: false,
      }),
    ).toBe(true);
    expect(
      mayRunAccess('api-key:a2a', 'bureau.workflows:read', 'library:custom', {
        allowOperatorScope: false,
      }),
    ).toBe(false);
  });

  it.each([
    ['workflows-create', { name: 'New workflow', trigger: TRIGGER, steps: STEPS }],
    ['workflows-update', { id: 'digest', expectedHash: 'hash', trigger: TRIGGER, steps: STEPS }],
    ['workflows-pause', { id: 'digest', expectedHash: 'hash' }],
    ['workflows-resume', { id: 'digest', expectedHash: 'hash' }],
    ['workflows-list', {}],
    ['workflows-validate', { id: 'draft', trigger: TRIGGER, steps: STEPS }],
    ['workflows-catalog', {}],
  ] as const)('authorizes %s for local runs and denies api-key:a2a', async (tool, input) => {
    const local = await withWorkflow();
    const localInput =
      tool === 'workflows-create' ||
      tool === 'workflows-list' ||
      tool === 'workflows-validate' ||
      tool === 'workflows-catalog'
        ? input
        : { ...input, expectedHash: hashOf(local, 'digest') };
    const localCall = await local.callTool(`bureau__${tool}`, localInput);
    expect(localCall.outcome, tool).toBe('success');
    expect(localCall.result, tool).toMatchObject({ status: 'ok' });

    const foreign = await withWorkflow();
    const foreignInput =
      tool === 'workflows-create' ||
      tool === 'workflows-list' ||
      tool === 'workflows-validate' ||
      tool === 'workflows-catalog'
        ? input
        : { ...input, expectedHash: hashOf(foreign, 'digest') };
    const foreignCall = await foreign.callTool(`bureau__${tool}`, foreignInput, {
      principal: 'api-key:a2a',
    });
    expect(foreignCall.outcome, tool).toBe('success');
    expect(foreignCall.result, tool).toEqual(
      tool === 'workflows-list'
        ? { status: 'ok', workflows: [] }
        : tool === 'workflows-validate' || tool === 'workflows-catalog'
          ? expect.objectContaining({ status: 'forbidden' })
          : { status: 'not-found', id: tool === 'workflows-create' ? 'new-workflow' : 'digest' },
    );
  });
});

describe('a chat session run', () => {
  it('acts as the session’s principal and agent, the same as a catalog run', async () => {
    const harness = await start();
    await harness.callTool('bureau__workflows-create', {
      name: 'Digest',
      trigger: TRIGGER,
      steps: STEPS,
    });

    const asOwner = await harness.callTool('bureau__workflows-list', {}, { via: 'session' });
    expect((asOwner.result as { workflows: unknown[] }).workflows).toHaveLength(1);

    const asAlice = await harness.callTool(
      'bureau__workflows-list',
      {},
      { via: 'session', principal: 'api-key:alice' },
    );
    expect(asAlice.result).toEqual({ status: 'ok', workflows: [] });

    const created = await harness.callTool(
      'bureau__workflows-create',
      { name: 'From chat', trigger: TRIGGER, steps: STEPS },
      { via: 'session' },
    );
    expect(created.result).toMatchObject({ status: 'ok', id: 'from-chat' });
    expect(await fileOf(harness, 'from-chat')).toMatchObject({ agent: 'scribe' });
  });
});

describe('agent-owned workflow runs', () => {
  it('rejects invalid input before creating a run, then records the agent-run origin', async () => {
    const harness = await start();
    await harness.putAgent('scribe');
    await harness.callTool('bureau__workflows-create', {
      name: 'Manual input',
      trigger: { kind: 'manual' },
      inputSchema: { type: 'object', required: ['value'] },
      steps: STEPS,
    });

    const invalid = await harness.callTool('bureau__workflows-start', {
      id: 'manual-input',
      input: {},
    });
    expect(invalid.result).toMatchObject({ status: 'invalid' });
    expect(await harness.bureau.workflows!.listRuns({ limit: 10, offset: 0 })).toMatchObject({
      runs: [],
    });

    const started = await harness.callTool('bureau__workflows-start', {
      id: 'manual-input',
      input: { value: 'ok' },
    });
    expect(started.result).toMatchObject({ status: 'ok' });
    const runId = (started.result as { runId: string }).runId;
    expect(typeof runId).toBe('string');
    expect(runId.length).toBeGreaterThan(0);
    let detail = await harness.bureau.workflows!.getRun(runId);
    await waitUntil(
      async () => {
        detail = await harness.bureau.workflows!.getRun(runId);
        return detail !== undefined;
      },
      { message: 'started workflow run did not become readable' },
    );
    expect(detail).toMatchObject({
      origin: { kind: 'agent-run', runId: started.runId, agentId: 'scribe' },
    });
    await harness.bureau.durableEngine()!.getHandle(runId).result();
    const audit = await harness.bureau.internals.auditTrail?.query({
      runId: 'workflow:manual-input',
    });
    expect(audit?.find((entry) => entry.type === 'workflow.started')).toMatchObject({
      principal: `agent-run:${started.runId}`,
      detail: { runId },
    });
    const history = await harness.bureau.workflows!.historyRuns(runId, 500);
    expect(history?.events.length).toBeGreaterThan(0);
    expect(history?.events.every((event) => !Object.hasOwn(event, 'data'))).toBe(true);
    expect(history?.events.every((event) => event.type.startsWith('file-workflow:'))).toBe(true);
    const toolHistory = await harness.callTool('bureau__workflows-runs-history', {
      runId,
      limit: 500,
    });
    expect(toolHistory.result).toMatchObject({ status: 'ok' });
    const toolEvents = (toolHistory.result as { events: readonly Record<string, unknown>[] })
      .events;
    expect(toolEvents.length).toBeGreaterThan(0);
    expect(toolEvents.every((event) => !Object.hasOwn(event, 'data'))).toBe(true);
  });

  it('signals a matching workflow and cancels a waiting run', async () => {
    const harness = await start();
    await harness.callTool('bureau__workflows-create', {
      name: 'Wait for go',
      trigger: { kind: 'signal', name: 'go' },
      steps: STEPS,
    });
    const signalled = await harness.callTool('bureau__workflows-signal', { name: 'go' });
    expect(signalled.result).toMatchObject({ status: 'ok' });
    const startedId = (signalled.result as { started: string[] }).started[0]!;
    expect(typeof startedId).toBe('string');
    await harness.bureau.durableEngine()!.getHandle(startedId).result();

    await harness.callTool('bureau__workflows-create', {
      name: 'Wait to cancel',
      trigger: { kind: 'manual' },
      steps: [{ kind: 'await-signal', signal: 'never' }],
    });
    const waiting = await harness.callTool('bureau__workflows-start', { id: 'wait-to-cancel' });
    const waitingId = (waiting.result as { runId: string }).runId;

    const cancelled = await harness.callTool('bureau__workflows-runs-cancel', { runId: waitingId });
    expect(cancelled.result).toEqual({ status: 'cancel-requested', runId: waitingId });
    let state = await harness.bureau.durableEngine()!.get(waitingId);
    await waitUntil(
      async () => {
        state = await harness.bureau.durableEngine()!.get(waitingId);
        return state?.status === 'cancelled';
      },
      { message: 'workflow run did not reach cancelled' },
    );
    expect(state?.status).toBe('cancelled');
  });

  it('validates run status filters and accepts the canceled spelling', async () => {
    const harness = await start();
    const invalid = await harness.callTool('bureau__workflows-runs-list', { status: 'unknown' });
    expect(invalid.outcome).not.toBe('success');
    expect(invalid.result).toContain('Invalid option');

    const canceled = await harness.callTool('bureau__workflows-runs-list', { status: 'canceled' });
    expect(canceled.result).toEqual({ status: 'ok', runs: [], nextOffset: null });
  });
});

describe('a calling agent whose identifier is not an agent identifier', () => {
  it('gets invalid-agent from every tool and writes nothing', async () => {
    const harness = await start();
    await harness.callTool('bureau__workflows-create', {
      name: 'Digest',
      trigger: TRIGGER,
      steps: STEPS,
    });
    const before = await readFile(join(harness.workflowsPath, 'digest.json'), 'utf8');
    const hash = hashOf(harness, 'digest');
    const tools = createWorkflowTools({
      workflows: () => harness.bureau.workflows,
      runIdentity: async () => ({ agent: 'Not An Agent', owner: harness.bureau.workflows!.owner }),
    });
    const run = (name: string, input: unknown) =>
      (
        tools[name] as unknown as {
          execute: (input: unknown, context: unknown) => Promise<unknown>;
        }
      ).execute(input, { executionContext: { parentRunId: 'run-1' } });

    const results = [
      await run('workflows-create', { name: 'Other', trigger: TRIGGER, steps: STEPS }),
      await run('workflows-update', {
        id: 'digest',
        expectedHash: hash,
        trigger: TRIGGER,
        steps: STEPS,
      }),
      await run('workflows-pause', { id: 'digest', expectedHash: hash }),
      await run('workflows-resume', { id: 'digest', expectedHash: hash }),
      await run('workflows-list', {}),
      await run('workflows-start', { id: 'digest' }),
      await run('workflows-signal', { name: 'go' }),
      await run('workflows-runs-cancel', { runId: 'run-1' }),
    ];

    for (const [index, result] of results.entries()) {
      if (index === 6) {
        expect(result).toEqual({ status: 'ok', started: [], delivered: [], rejected: [] });
        continue;
      }
      expect(result).toMatchObject({ status: 'invalid', code: 'invalid-agent' });
      expect((result as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
    }
    expect(await readFile(join(harness.workflowsPath, 'digest.json'), 'utf8')).toBe(before);
    expect(harness.bureau.workflows!.list().map((entry) => entry.id)).toEqual(['digest']);
  });
});

describe('a file written by hand', () => {
  it('is listed and can be paused by an agent that did not write it', async () => {
    const harness = await start();
    await Bun.write(
      join(harness.workflowsPath, 'by-hand.json'),
      workflowFileText('by-hand', { agent: 'someone' }),
    );
    await harness.bureau.workflows!.refresh();
    const { result } = await harness.callTool('bureau__workflows-pause', {
      id: 'by-hand',
      expectedHash: hashOf(harness, 'by-hand'),
    });
    expect(result).toMatchObject({ status: 'ok', id: 'by-hand' });
    expect(await fileOf(harness, 'by-hand')).toMatchObject({ agent: 'someone', paused: true });
  });
});

describe('what a person is shown of each tool', () => {
  it('is one line of at most 120 characters per tool, apart from the prompt the model reads', () => {
    const tools: Record<string, Tool> = createWorkflowTools({
      workflows: () => undefined,
      runIdentity: async () => ({ agent: undefined, owner: undefined }),
    });
    for (const name of WORKFLOW_TOOL_NAMES) {
      const line = readToolShortDescription(tools[name]?.metadata);
      expect(line, name).toBeDefined();
      expect(line?.length, name).toBeLessThanOrEqual(120);
      expect(line, name).not.toBe(tools[name]?.description);
    }
  });
});
