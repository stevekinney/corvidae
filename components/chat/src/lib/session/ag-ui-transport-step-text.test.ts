import { describe, expect, test } from 'bun:test';
import {
  bodies,
  completedConversation,
  frames,
  runFinished,
  runStarted,
  transcript,
} from './ag-ui-transport-test-support.ts';

const started = { type: 'run.started', runId: 'run-1' };

describe('AG-UI STEP_* events', () => {
  test('become metadata blocks that open and complete', async () => {
    expect(
      await bodies([
        runStarted,
        { type: 'STEP_STARTED', stepName: 'retrieve' },
        { type: 'STEP_FINISHED', stepName: 'retrieve' },
        { type: 'STEP_STARTED', stepName: 'answer' },
        { type: 'STEP_FINISHED', stepName: 'answer' },
        runFinished,
      ]).then((all) => all.slice(0, -1)),
    ).toEqual([
      started,
      {
        type: 'stream:block-start',
        block: {
          id: 'step:retrieve:0',
          type: 'metadata',
          index: 0,
          content: 'retrieve',
          complete: false,
        },
      },
      {
        type: 'stream:block-complete',
        block: {
          id: 'step:retrieve:0',
          type: 'metadata',
          index: 0,
          content: 'retrieve',
          complete: true,
        },
      },
      {
        type: 'stream:block-start',
        block: {
          id: 'step:answer:1',
          type: 'metadata',
          index: 1,
          content: 'answer',
          complete: false,
        },
      },
      {
        type: 'stream:block-complete',
        block: {
          id: 'step:answer:1',
          type: 'metadata',
          index: 1,
          content: 'answer',
          complete: true,
        },
      },
    ]);
  });
});

describe('AG-UI TEXT_MESSAGE_* events', () => {
  test('stream an assistant message as one step addressed by message id', async () => {
    const all = await bodies([
      runStarted,
      { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hel' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'lo' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
      runFinished,
    ]);
    expect(all.slice(0, -1)).toEqual([
      started,
      { type: 'assistant.step.started', step: 0, messageId: 'm1' },
      { type: 'stream:text-delta', content: 'Hel', accumulated: 'Hel', messageId: 'm1' },
      { type: 'stream:text-delta', content: 'lo', accumulated: 'Hello', messageId: 'm1' },
      { type: 'assistant.step.completed', step: 0, messageId: 'm1' },
    ]);
    expect(all.at(-1)).toMatchObject({ type: 'run.completed', content: 'Hello' });
  });

  test('give each assistant message its own step, and assemble them into the terminal', async () => {
    const all = await frames([
      runStarted,
      { type: 'TEXT_MESSAGE_START', messageId: 'm1' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'one' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
      { type: 'TEXT_MESSAGE_START', messageId: 'm2' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm2', delta: 'two' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm2' },
      runFinished,
    ]);
    expect(
      all.flatMap((frame) => (frame.type === 'assistant.step.started' ? [frame.step] : [])),
    ).toEqual([0, 1]);
    expect(all.at(-1)).toMatchObject({ content: 'one\n\ntwo' });
    expect(transcript(completedConversation(all))).toEqual([
      ['assistant', 'one'],
      ['assistant', 'two'],
    ]);
  });

  test('leave an assistant message that said nothing out of the terminal', async () => {
    const all = await frames([
      runStarted,
      { type: 'TEXT_MESSAGE_START', messageId: 'm1' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
      runFinished,
    ]);
    expect(completedConversation(all).ids).toEqual([]);
  });

  test('skip a message from a role the session already owns', async () => {
    const all = await bodies([
      runStarted,
      { type: 'TEXT_MESSAGE_START', messageId: 'u1', role: 'user' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'u1', delta: 'echoed' },
      { type: 'TEXT_MESSAGE_END', messageId: 'u1' },
      runFinished,
    ]);
    expect(all.map((frame) => frame['type'])).toEqual(['run.started', 'run.completed']);
  });

  test('TEXT_MESSAGE_CHUNK opens a message on its first chunk and closes it on a change', async () => {
    const all = await bodies([
      runStarted,
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm1', role: 'assistant', delta: 'Hel' },
      { type: 'TEXT_MESSAGE_CHUNK', delta: 'lo' },
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm2', delta: 'Bye' },
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'u1', role: 'user', delta: 'ignored' },
      { type: 'TEXT_MESSAGE_CHUNK', messageId: 'm3' },
      runFinished,
    ]);
    expect(all.slice(0, -1)).toEqual([
      started,
      { type: 'assistant.step.started', step: 0, messageId: 'm1' },
      { type: 'stream:text-delta', content: 'Hel', accumulated: 'Hel', messageId: 'm1' },
      { type: 'stream:text-delta', content: 'lo', accumulated: 'Hello', messageId: 'm1' },
      { type: 'assistant.step.completed', step: 0, messageId: 'm1' },
      { type: 'assistant.step.started', step: 1, messageId: 'm2' },
      { type: 'stream:text-delta', content: 'Bye', accumulated: 'Bye', messageId: 'm2' },
      { type: 'assistant.step.completed', step: 1, messageId: 'm2' },
      { type: 'assistant.step.started', step: 2, messageId: 'm3' },
      { type: 'assistant.step.completed', step: 2, messageId: 'm3' },
    ]);
  });
});
