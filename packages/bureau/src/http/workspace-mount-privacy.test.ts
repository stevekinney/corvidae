import { WORKSPACE_MOUNT_CONFORMANCE } from './workspace-conformance.test-support.ts';
import { expect, test } from 'bun:test';
import { waitForCondition } from '../test';
import { as } from './management/management-fixtures.test-support.ts';
import { attachRunRequest, attachThreadRequest } from './ag-ui-fixtures.test-support.ts';
import { readAgUiStream } from './ag-ui-stream.test-support.ts';
import {
  openWorkspacePrivacyBureau,
  WORKSPACE_PRIVACY_ACTORS,
  type WorkspacePrivacyActor,
} from './workspace-privacy-fixtures.test-support.ts';

const actors = Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[];
const sentinel = WORKSPACE_MOUNT_CONFORMANCE.agUi.sentinel;

for (const kind of ['run', 'thread'] as const) {
  test(`AG-UI ${kind} attachment protects replayed answer bytes across six actors`, async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const opened = await openWorkspacePrivacyBureau({
      a2aAgents: ['default'],
      handlerOptions: { agUi: {} },
      generate: async () => {
        await gate;
        return { content: sentinel, toolCalls: [] };
      },
    });
    try {
      const task = await opened.bureau.tasks.start('default', sentinel, {
        principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
      });
      await waitForCondition(
        () => opened.bureau.internals.runEventFeeds.get(task.id) !== undefined,
        'live run exists',
      );
      const id = kind === 'run' ? task.id : task.contextId;
      const request = (identifier: string, actor: WorkspacePrivacyActor) =>
        (kind === 'run' ? attachRunRequest : attachThreadRequest)(
          identifier,
          as(WORKSPACE_PRIVACY_ACTORS[actor].key),
        );
      for (const actor of [
        ...actors.filter((candidate) => candidate !== 'owner'),
        'owner',
      ] as WorkspacePrivacyActor[]) {
        const response = await opened.handler(request(id, actor));
        if (actor === 'foreign' || actor === 'removed') expect(response.status).toBe(403);
        else if (actor === 'owner') {
          expect(response.status).toBe(200);
          const reading = readAgUiStream(response);
          release();
          const frames = await reading;
          expect(JSON.stringify(frames)).toContain(sentinel);
        } else {
          expect(response.status).toBe(200);
          const deniedFrames = await readAgUiStream(response);
          const unknown = await opened.handler(request('unknown-resource', actor));
          const missingFrames = await readAgUiStream(unknown);
          const errors = (frames: typeof deniedFrames, identifier: string) =>
            frames.map(({ event }) => {
              const { timestamp: _timestamp, ...stable } = event;
              return JSON.stringify(stable).replaceAll(identifier, '<id>');
            });
          expect(errors(deniedFrames, id)).toEqual(errors(missingFrames, 'unknown-resource'));
          expect(JSON.stringify(deniedFrames)).toContain(
            kind === 'run' ? 'RUN_NOT_FOUND' : 'THREAD_NOT_FOUND',
          );
          expect(JSON.stringify(deniedFrames)).not.toContain(sentinel);
        }
      }
    } finally {
      release();
      await opened.dispose();
    }
  });
}

test('A2A task reads and lists protect private task content across six actors', async () => {
  const a2aSentinel = WORKSPACE_MOUNT_CONFORMANCE.a2a.sentinel;
  const opened = await openWorkspacePrivacyBureau({
    a2aAgents: ['default'],
    handlerOptions: { publicUrl: 'http://localhost' },
    generate: async () => ({ content: a2aSentinel, toolCalls: [] }),
  });
  try {
    const call = async (actor: WorkspacePrivacyActor, method: string, params: unknown) => {
      const response = await opened.handler(
        new Request('http://localhost/a2a/default', {
          method: 'POST',
          headers: {
            ...as(WORKSPACE_PRIVACY_ACTORS[actor].key),
            'content-type': 'application/json',
            'A2A-Version': '1.0',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        }),
      );
      const text = await response.text();
      const body = response.headers.get('content-type')?.includes('application/json')
        ? (JSON.parse(text) as {
            result?: { task?: { id: string }; tasks?: unknown[]; totalSize?: number };
            error?: { code: number };
          })
        : undefined;
      return { status: response.status, text, body };
    };
    const sent = await call('owner', 'SendMessage', {
      message: { messageId: 'owner-message', role: 'ROLE_USER', parts: [{ text: a2aSentinel }] },
    });
    expect(sent.body?.error).toBeUndefined();
    const taskId = sent.body?.result?.task?.id;
    expect(typeof taskId).toBe('string');
    for (const actor of actors) {
      const result = await call(actor, 'GetTask', { id: taskId });
      const listed = await call(actor, 'ListTasks', {});
      if (actor === 'foreign' || actor === 'removed') {
        expect(result.status).toBe(403);
        expect(listed.status).toBe(403);
      } else if (actor === 'owner') {
        expect(result.body?.error).toBeUndefined();
        expect(result.text).toContain(a2aSentinel);
        expect(listed.body?.result?.tasks).toHaveLength(1);
      } else {
        expect(result.body?.error?.code).toBe(-32001);
        const unknown = await call(actor, 'GetTask', { id: 'unknown-task' });
        expect(JSON.stringify(result.body?.error).replaceAll(String(taskId), '<id>')).toBe(
          JSON.stringify(unknown.body?.error).replaceAll('unknown-task', '<id>'),
        );
        expect(listed.body?.result?.tasks ?? []).toEqual([]);
        expect(listed.body?.result?.totalSize).toBe(0);
        expect(result.text + listed.text).not.toContain(a2aSentinel);
      }
    }
  } finally {
    await opened.dispose();
  }
});
