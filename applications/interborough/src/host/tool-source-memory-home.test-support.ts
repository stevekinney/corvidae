import type { ConfigurationWriteCondition, ConfigurationWriteResult } from '@lostgradient/bungalow';
/**
 * A home that holds its configuration and secrets in memory and fails the way a test says, for the
 * tool-source manager tests (COR-1930).
 */
import type { AnswerEncryptionKeys } from '@lostgradient/bureau';
import { generateEncryptionKey } from '@lostgradient/cryptography';

/** How a configuration write fails. */
export type Failure = 'none' | 'before-replacing' | 'after-replacing';

/** A home that holds its configuration and secrets in memory and fails the way a test says. */
export function memoryHome(mode: 'local' | 'remote' = 'local') {
  const state = {
    configuration: undefined as string | undefined,
    secrets: new Map<string, string>(),
    configurationFailure: 'none' as Failure,
    secretWritesBeforeFailing: Number.POSITIVE_INFINITY,
    secretWrites: 0,
  };
  const bungalow = {
    mode,
    configurationLocation: '/home/configuration.json',
    readConfiguration: async () => ({
      text: state.configuration,
      revision: state.configuration === undefined ? null : Bun.hash(state.configuration).toString(),
    }),
    writeConfiguration: async (
      text: string,
      condition: ConfigurationWriteCondition,
    ): Promise<ConfigurationWriteResult> => {
      if (
        condition.expectedRevision !==
        (state.configuration === undefined ? null : Bun.hash(state.configuration).toString())
      )
        return { outcome: 'conflict' };
      if (state.configurationFailure === 'before-replacing') return { outcome: 'unavailable' };
      state.configuration = text;
      if (state.configurationFailure === 'after-replacing') return { outcome: 'unknown' };
      return { outcome: 'committed' };
    },
    readSecret: (key: string) => state.secrets.get(key),
    writeSecret: (key: string, value: string) => {
      state.secretWrites += 1;
      if (state.secretWrites > state.secretWritesBeforeFailing) throw new Error('secret disk full');
      state.secrets.set(key, value);
    },
  };
  return { state, bungalow };
}

export async function keysOf(): Promise<AnswerEncryptionKeys> {
  return { current: await generateEncryptionKey() };
}
