/**
 * The push install protocol (COR-1669): how a push configuration and the checkpoint that makes it
 * deliverable come to exist together.
 *
 * The checkpoint is written ahead of its configuration, marked pending, so a crash between the two
 * writes leaves a checkpoint that a restart confirms or removes, and never a configuration that no
 * checkpoint knows. The caller runs an install and a delete of the same task through one fence
 * ({@link A2APushProjector.fence}), so neither interleaves with the other.
 *
 * A failed `create` is not taken as proof that nothing was written: the store may have committed
 * before the failure reached the caller. The install asks the store whether that configuration exists first, and
 * removes the pending checkpoint only when the configuration is definitely absent; when the
 * read-back fails too, the pending checkpoint stays for a restart to settle.
 *
 * @module a2a-push-install
 */

import type { ServerCallContext } from '@a2a-js/sdk/server';
import type { TaskPushNotificationConfig } from '@a2a-js/sdk';
import {
  A2APushConfigurationConflictError,
  type WeftPushNotificationStore,
} from '@lostgradient/weft/a2a';

import type { A2APushCaller, A2APushCheckpoints } from './a2a-push-checkpoint.ts';

/** What an install reads and writes. */
export type A2APushInstallDependencies = {
  readonly store: Pick<WeftPushNotificationStore, 'check' | 'create'>;
  readonly checkpoints: Pick<A2APushCheckpoints, 'create' | 'confirm' | 'removePending'>;
  /** Starts (or nudges) the projection of the task's history. */
  readonly watch: (taskId: string) => void;
  /** A fresh identifier. Defaults to `crypto.randomUUID`. */
  readonly newId?: (() => string) | undefined;
};

/** One install. */
export type A2APushInstallInput = {
  readonly taskId: string;
  readonly configuration: TaskPushNotificationConfig;
  readonly context: ServerCallContext;
  readonly caller: A2APushCaller;
  /** Where the checkpoint starts; the configuration receives every event after it. */
  readonly cursor: string;
};

/**
 * Installs a push configuration on a task and starts its checkpoint at the cursor. Both writes
 * are idempotent: a repeat of the same configuration leaves one configuration and keeps the
 * earliest checkpoint. The caller holds the task's fence.
 */
export async function installPushConfiguration(
  dependencies: A2APushInstallDependencies,
  input: A2APushInstallInput,
): Promise<TaskPushNotificationConfig> {
  const { store, checkpoints, watch } = dependencies;
  const { taskId, configuration, context, caller, cursor } = input;
  const newId = dependencies.newId ?? (() => crypto.randomUUID());
  const repeated =
    configuration.id === '' ? await store.check(taskId, context, configuration) : undefined;
  const configId = configuration.id === '' ? (repeated?.id ?? newId()) : configuration.id;
  const installId = newId();
  const pendingCheckpoint = (id: string) => ({
    recordVersion: 1 as const,
    taskId,
    configId: id,
    cursor,
    caller,
    pending: true as const,
    installId,
  });
  await checkpoints.create(pendingCheckpoint(configId));
  const request = { ...structuredClone(configuration), id: configId, taskId };
  let stored: TaskPushNotificationConfig;
  try {
    stored = await store.create(taskId, context, request);
  } catch (error) {
    // The failure may have followed the commit. `check` answers whether this very configuration
    // exists: only a definite absence (or a conflict with another configuration) releases the
    // checkpoint written for it, and a check that fails too leaves it for a restart to settle.
    let committed: TaskPushNotificationConfig | undefined;
    try {
      committed = await store.check(taskId, context, structuredClone(request));
    } catch (checkError) {
      if (checkError instanceof A2APushConfigurationConflictError) {
        await checkpoints.removePending(taskId, configId, installId);
      }
      throw error;
    }
    if (committed === undefined) {
      await checkpoints.removePending(taskId, configId, installId);
      throw error;
    }
    stored = committed;
  }
  if (stored.id !== configId) {
    // A concurrent create of the same webhook won: its configuration is the one checkpointed,
    // and an existing checkpoint (the earlier cursor) is kept.
    await checkpoints.removePending(taskId, configId, installId);
    await checkpoints.create(pendingCheckpoint(stored.id));
  }
  await checkpoints.confirm(taskId, stored.id);
  watch(taskId);
  return stored;
}
