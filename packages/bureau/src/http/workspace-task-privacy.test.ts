import { expect, test } from 'bun:test';
import { waitForCondition } from '../test';
import { readFrames, subscribeRequest } from './management/management-fixtures.test-support.ts';
import {
  openWorkspacePrivacyBureau,
  workspacePrivacyCall,
  WORKSPACE_PRIVACY_ACTORS,
  type WorkspacePrivacyActor,
} from './workspace-privacy-fixtures.test-support.ts';

const actors = Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[];
const sentinel = 'PRIVATE-TASK-ANSWER-e5b2';

for (const operation of ['bureau.tasks.inspect', 'bureau.tasks.cancel'] as const) {
  test(`${operation} checks actual task ownership for all six actors`, async () => {
    const opened = await openWorkspacePrivacyBureau();
    try {
      for (const actor of actors) {
        const task = await opened.bureau.tasks.start('default', sentinel, {
          principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
        });
        const result = await workspacePrivacyCall(opened, actor, operation, { taskId: task.id });
        if (actor === 'foreign' || actor === 'removed') expect(result.status).toBe(403);
        else if (actor === 'owner') expect(result.body?.error).toBeUndefined();
        else {
          expect(result.body?.error?.data?.httpStatus).toBe(404);
          const missing = await workspacePrivacyCall(opened, actor, operation, {
            taskId: 'unknown-task',
          });
          expect(JSON.stringify(result.body?.error).replaceAll(task.id, '<id>')).toBe(
            JSON.stringify(missing.body?.error).replaceAll('unknown-task', '<id>'),
          );
          expect(result.text).not.toContain(sentinel);
        }
      }
    } finally {
      await opened.dispose();
    }
  });
}

test('bureau.tasks.events SSE yields private answer bytes only to its owner across six actors', async () => {
  const opened = await openWorkspacePrivacyBureau({
    durableHistory: true,
    generate: async () => ({ content: sentinel, toolCalls: [] }),
  });
  try {
    const task = await opened.bureau.tasks.start('default', 'private input', {
      principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
    });
    await waitForCondition(
      () => opened.bureau.tasks.detail(task.id)?.status === 'completed',
      'task completes',
    );
    for (const actor of actors) {
      const key = WORKSPACE_PRIVACY_ACTORS[actor].key;
      const response = await opened.handler(
        subscribeRequest('bureau.tasks.events', { taskId: task.id }, key),
      );
      if (actor === 'foreign' || actor === 'removed') expect(response.status).toBe(403);
      else if (actor === 'owner') {
        expect(response.status).toBe(200);
        const frames = await readFrames(response);
        expect(JSON.stringify(frames)).toContain(sentinel);
      } else {
        expect(response.status).toBe(404);
        const missing = await opened.handler(
          subscribeRequest('bureau.tasks.events', { taskId: 'unknown-task' }, key),
        );
        const text = await response.text();
        expect(text).not.toContain(sentinel);
        const missingText = await missing.text();
        expect(text.replaceAll(task.id, '<id>')).toBe(
          missingText.replaceAll('unknown-task', '<id>'),
        );
      }
    }
  } finally {
    await opened.dispose();
  }
});

test('bureau.tasks.respond admits the owner answer and hides the wait from all other actors', async () => {
  const opened = await openWorkspacePrivacyBureau({
    generate: async () => ({
      content: '',
      toolCalls: [
        {
          id: 'private-wait',
          name: 'requestHumanInput',
          arguments: { signalName: 'private-answer', prompt: sentinel },
        },
      ],
    }),
  });
  try {
    const task = await opened.bureau.tasks.start('default', 'wait for owner', {
      principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
    });
    await waitForCondition(
      () => opened.bureau.reviews.list().some((review) => review.runId === task.id),
      'task waits for answer',
    );
    // Answer last so every denied request observes the same live wait.
    for (const actor of [
      ...actors.filter((candidate) => candidate !== 'owner'),
      'owner',
    ] as WorkspacePrivacyActor[]) {
      const input = { taskId: task.id, messageId: `answer-${actor}`, answer: 'owner answer' };
      const result = await workspacePrivacyCall(opened, actor, 'bureau.tasks.respond', input);
      if (actor === 'foreign' || actor === 'removed') expect(result.status).toBe(403);
      else if (actor === 'owner') expect(result.body?.error).toBeUndefined();
      else {
        expect(result.body?.error?.data?.httpStatus).toBe(404);
        const unknown = await workspacePrivacyCall(opened, actor, 'bureau.tasks.respond', {
          ...input,
          taskId: 'unknown-task',
        });
        expect(JSON.stringify(result.body?.error).replaceAll(task.id, '<id>')).toBe(
          JSON.stringify(unknown.body?.error).replaceAll('unknown-task', '<id>'),
        );
        expect(result.text).not.toContain(sentinel);
      }
    }
  } finally {
    await opened.dispose();
  }
});

test('operative.runs.events exposes an owned feed only to its owner across six actors', async () => {
  const opened = await openWorkspacePrivacyBureau();
  try {
    const task = await opened.bureau.tasks.start('default', sentinel, {
      principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
    });
    await waitForCondition(
      () => opened.bureau.internals.runEventFeeds.get(task.id) !== undefined,
      'run feed exists',
    );
    for (const actor of actors) {
      const key = WORKSPACE_PRIVACY_ACTORS[actor].key;
      const response = await opened.handler(
        subscribeRequest('operative.runs.events', { runId: task.id }, key),
      );
      if (actor === 'foreign' || actor === 'removed') expect(response.status).toBe(403);
      else if (actor === 'owner') {
        expect(response.status).toBe(200);
        const frames = await readFrames(response, {
          stop: (seen) => seen.some((frame) => frame.event === 'run.started'),
        });
        expect(JSON.stringify(frames)).toContain(task.id);
      } else {
        expect(response.status).toBe(404);
        const unknown = await opened.handler(
          subscribeRequest('operative.runs.events', { runId: 'unknown-run' }, key),
        );
        const deniedText = await response.text();
        const unknownText = await unknown.text();
        expect(deniedText.replaceAll(task.id, '<id>')).toBe(
          unknownText.replaceAll('unknown-run', '<id>'),
        );
        expect(deniedText).not.toContain(sentinel);
      }
    }
  } finally {
    await opened.dispose();
  }
});
