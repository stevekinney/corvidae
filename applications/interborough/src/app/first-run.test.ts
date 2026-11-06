/**
 * The first-run checklist's rules (`first-run.ts`): which signal completes each step, when the
 * checklist is over, and how the dismissal is kept when storage cannot be trusted.
 */
import { describe, expect, test } from 'bun:test';

import {
  FIRST_RUN_ASSISTANT_KEY,
  FIRST_RUN_DISMISSED_KEY,
  FIRST_RUN_SAID_HELLO_KEY,
  firstRunComplete,
  firstRunProgress,
  homeChecklistShows,
  readAssistantChosen,
  readFirstRunDismissed,
  readSaidHello,
  stepsLeft,
  writeAssistantChosen,
  writeFirstRunDismissed,
  writeSaidHello,
} from './first-run.ts';

const NOTHING = { providers: [], agents: [], chatCount: 0 } as const;

/** A storage over a map, with the failures a blocked window gives. */
function storageOf(
  initial: Record<string, string> = {},
  failures: { read?: boolean; write?: boolean } = {},
): Storage & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return Object.assign(Object.create(null) as Storage, {
    values,
    getItem(key: string): string | null {
      if (failures.read === true) throw new Error('blocked');
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (failures.write === true) throw new Error('full');
      values.set(key, value);
    },
  });
}

describe('the steps', () => {
  test('are all open on a fresh installation', () => {
    const progress = firstRunProgress(NOTHING);
    expect(progress).toEqual({ provider: false, agent: false, chat: false });
    expect(firstRunComplete(progress)).toBe(false);
  });

  test('a provider is connected once one holds a key, not once one is listed', () => {
    expect(firstRunProgress({ ...NOTHING, providers: [{ hasKey: false }] }).provider).toBe(false);
    expect(
      firstRunProgress({ ...NOTHING, providers: [{ hasKey: false }, { hasKey: true }] }).provider,
    ).toBe(true);
  });

  test('an agent exists once one is defined in a file, not once the host ships one in code', () => {
    expect(firstRunProgress({ ...NOTHING, agents: [{ kind: 'code' }] }).agent).toBe(false);
    expect(
      firstRunProgress({ ...NOTHING, agents: [{ kind: 'code' }, { kind: 'file' }] }).agent,
    ).toBe(true);
  });

  test('a chat exists once the Bureau lists one', () => {
    expect(firstRunProgress({ ...NOTHING, chatCount: 1 }).chat).toBe(true);
  });

  test('are complete only when all three are done', () => {
    expect(firstRunComplete({ provider: true, agent: true, chat: false })).toBe(false);
    expect(firstRunComplete({ provider: true, agent: true, chat: true })).toBe(true);
  });
});

describe('the dismissal', () => {
  test('is kept under the key the interface documents', () => {
    expect(FIRST_RUN_DISMISSED_KEY).toBe('interborough:first-run:dismissed');
    const storage = storageOf();
    expect(readFirstRunDismissed(storage)).toBe(false);
    writeFirstRunDismissed(storage);
    expect(storage.values.get(FIRST_RUN_DISMISSED_KEY)).toBe('true');
    expect(readFirstRunDismissed(storage)).toBe(true);
  });

  test('is not read from any other value', () => {
    expect(readFirstRunDismissed(storageOf({ [FIRST_RUN_DISMISSED_KEY]: 'yes' }))).toBe(false);
  });

  test('is not lost to storage that throws: a failed read is not dismissed, a failed write is ignored', () => {
    expect(readFirstRunDismissed(storageOf({}, { read: true }))).toBe(false);
    expect(() => writeFirstRunDismissed(storageOf({}, { write: true }))).not.toThrow();
  });
});

describe('Home’s checklist', () => {
  test('choosing Assistant is how the second step is done without an agent made', () => {
    expect(firstRunProgress({ ...NOTHING, assistantChosen: true }).agent).toBe(true);
    expect(firstRunProgress({ ...NOTHING, assistantChosen: false }).agent).toBe(false);
  });

  test('shows until the chat step is done, whatever the provider and agent steps say', () => {
    expect(homeChecklistShows({ provider: false, agent: false, chat: false }, false)).toBe(true);
    expect(homeChecklistShows({ provider: true, agent: true, chat: false }, false)).toBe(true);
    // A chat with no provider connected ends it: the notice moves to Needs attention.
    expect(homeChecklistShows({ provider: false, agent: false, chat: true }, false)).toBe(false);
  });

  test('never returns once a chat happened, even when none is listed any more', () => {
    expect(homeChecklistShows({ provider: false, agent: false, chat: false }, true)).toBe(false);
  });

  test('counts the steps still open', () => {
    expect(stepsLeft({ provider: false, agent: false, chat: false })).toBe(3);
    expect(stepsLeft({ provider: true, agent: false, chat: false })).toBe(2);
    expect(stepsLeft({ provider: true, agent: true, chat: false })).toBe(1);
    expect(stepsLeft({ provider: true, agent: true, chat: true })).toBe(0);
  });

  test('keeps the choice of Assistant and that a chat happened, each under its own key', () => {
    expect(FIRST_RUN_ASSISTANT_KEY).toBe('interborough:first-run:assistant');
    expect(FIRST_RUN_SAID_HELLO_KEY).toBe('interborough:first-run:said-hello');
    const storage = storageOf();
    expect([readAssistantChosen(storage), readSaidHello(storage)]).toEqual([false, false]);
    writeAssistantChosen(storage);
    expect([readAssistantChosen(storage), readSaidHello(storage)]).toEqual([true, false]);
    writeSaidHello(storage);
    expect([readAssistantChosen(storage), readSaidHello(storage)]).toEqual([true, true]);
    // Neither is the dismissal.
    expect(readFirstRunDismissed(storage)).toBe(false);
  });

  test('is not lost to storage that throws', () => {
    expect(readAssistantChosen(storageOf({}, { read: true }))).toBe(false);
    expect(readSaidHello(storageOf({}, { read: true }))).toBe(false);
    expect(() => writeAssistantChosen(storageOf({}, { write: true }))).not.toThrow();
    expect(() => writeSaidHello(storageOf({}, { write: true }))).not.toThrow();
  });
});
