import type { PushNotificationStore, TaskStore } from '@a2a-js/sdk/server';
import { MemoryStorage } from '@lostgradient/weft';
import {
  createWeftA2ATaskStore,
  createWeftPushNotificationStore,
  type WeftA2ATaskStore,
  type WeftPushNotificationStore,
} from '@lostgradient/weft/a2a';

const storage = new MemoryStorage();

// Both factories satisfy the SDK's store interfaces.
const _taskStore: TaskStore = createWeftA2ATaskStore({ storage, namespace: 'agent' });
const _pushStore: PushNotificationStore = createWeftPushNotificationStore({
  storage,
  namespace: 'agent',
});

// The Weft extensions stay on the returned types.
const _prune: () => Promise<number> = createWeftA2ATaskStore({
  storage,
  namespace: 'agent',
  terminalRetentionMs: 1_000,
  now: () => 0,
}).prune;
const _weftTaskStore: WeftA2ATaskStore = createWeftA2ATaskStore({ storage, namespace: 'agent' });
const _weftPushStore: WeftPushNotificationStore = createWeftPushNotificationStore({
  storage,
  namespace: 'agent',
  now: () => 0,
});

// @ts-expect-error A namespace is required: one per published agent.
createWeftA2ATaskStore({ storage });

// @ts-expect-error A namespace is required: one per published agent.
createWeftPushNotificationStore({ storage });

void [_taskStore, _pushStore, _prune, _weftTaskStore, _weftPushStore];
