import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';

import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { createCheckpointStore } from './checkpoint-store';
import { diffConversationSnapshot } from './snapshot-delta';
import { createStorageActivities } from './storage-activities';

function setup() {
  const checkpointStore = createCheckpointStore(textValueStore(new MemoryStorage()));
  const activities = createStorageActivities(checkpointStore);
  const conversation = new Conversation(createConversationHistory());
  conversation.appendUserMessage('Loop');
  const base = conversation.snapshot();
  conversation.appendAssistantMessage('step 0');
  const next = conversation.snapshot();
  return { checkpointStore, activities, base, next, delta: diffConversationSnapshot(base, next) };
}

describe('saveConversation with a conversation delta (COR-1376)', () => {
  it('applies the delta to the transcript the run saved last', async () => {
    const { checkpointStore, activities, base, next, delta } = setup();
    await activities.saveConversation({ runId: 'run', snapshot: base });

    await activities.saveConversation({ runId: 'run', delta });

    expect(await checkpointStore.loadConversation('run')).toEqual(
      JSON.parse(JSON.stringify(next)) as typeof next,
    );
  });

  it('leaves the transcript alone when a retry finds the delta already applied', async () => {
    const { checkpointStore, activities, base, next, delta } = setup();
    await activities.saveConversation({ runId: 'run', snapshot: base });
    await activities.saveConversation({ runId: 'run', delta });

    await activities.saveConversation({ runId: 'run', delta });

    const saved = await checkpointStore.loadConversation('run');
    expect(saved?.integrity).toEqual(next.integrity);
  });

  it('rejects a delta when the run has no saved transcript', async () => {
    const { activities, delta } = setup();
    expect(await throwingRejectionOf(activities.saveConversation({ runId: 'run', delta }))).toThrow(
      'has no saved transcript',
    );
  });

  it('rejects a delta whose base is not the saved transcript', async () => {
    const { activities, next, delta } = setup();
    const unrelated = new Conversation(createConversationHistory());
    unrelated.appendUserMessage('Something else');
    await activities.saveConversation({ runId: 'run', snapshot: unrelated.snapshot() });
    expect(next.integrity.digest).not.toBe(unrelated.snapshot().integrity.digest);

    expect(await throwingRejectionOf(activities.saveConversation({ runId: 'run', delta }))).toThrow(
      'replay diverged',
    );
  });
});
