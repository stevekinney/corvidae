/**
 * The first-run checklist's rules (`first-run.ts`): which signal completes each step, when the
 * checklist is over, and how its two browser facts are kept when storage cannot be trusted.
 */
import { describe, expect, test } from 'bun:test';

import {
  CHAT_READINESS_PATHS,
  chatReadiness,
  FIRST_RUN_ASSISTANT_KEY,
  FIRST_RUN_SAID_HELLO_KEY,
  firstRunProgress,
  homeChecklistShows,
  readAssistantChosen,
  readSaidHello,
  stepsLeft,
  writeAssistantChosen,
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

// COR-2438: whether a chat can work, read by every place that starts one.
describe('whether a chat can work', () => {
  const connected = [{ connected: true }];
  const unconnected = [{ connected: false }];
  const modelAgent = { media: { image: false } };
  const scripted = { media: null };

  test('asks for a provider first when there is neither a provider nor an agent', () => {
    expect(chatReadiness({ providers: [], agents: [] })).toBe('needs-provider');
    expect(chatReadiness({ providers: unconnected, agents: [] })).toBe('needs-provider');
  });

  test('asks for an agent when a provider is connected and no agent is offered', () => {
    expect(chatReadiness({ providers: connected, agents: [] })).toBe('needs-agent');
    expect(
      chatReadiness({ providers: connected, agents: [{ ...modelAgent, visibility: 'hidden' }] }),
    ).toBe('needs-agent');
  });

  test('is ready with a provider and an agent', () => {
    expect(chatReadiness({ providers: connected, agents: [modelAgent] })).toBe('ready');
  });

  test('asks for a provider when every agent needs a model and none can be called', () => {
    expect(chatReadiness({ providers: unconnected, agents: [modelAgent] })).toBe('needs-provider');
  });

  test('is ready with a scripted agent, which needs no provider, as Assistant does', () => {
    expect(chatReadiness({ providers: [], agents: [scripted, modelAgent] })).toBe('ready');
    // A hidden scripted agent is not one Chat offers.
    expect(chatReadiness({ providers: [], agents: [{ ...scripted, visibility: 'hidden' }] })).toBe(
      'needs-provider',
    );
  });

  test('reads its provider step by the checklist’s own rule', () => {
    for (const providers of [[], connected, unconnected]) {
      const provider = firstRunProgress({ ...NOTHING, providers }).provider;
      expect(chatReadiness({ providers, agents: [modelAgent] }) === 'ready').toBe(provider);
    }
    expect(CHAT_READINESS_PATHS).toEqual({
      'needs-provider': '/settings/models',
      'needs-agent': '/agents/new',
    });
  });
});

describe('the steps', () => {
  test('are all open on a fresh installation', () => {
    const progress = firstRunProgress(NOTHING);
    expect(progress).toEqual({ provider: false, agent: false, chat: false });
  });

  test('a provider is connected once one holds a key, not once one is listed', () => {
    expect(firstRunProgress({ ...NOTHING, providers: [{ connected: false }] }).provider).toBe(
      false,
    );
    expect(
      firstRunProgress({
        ...NOTHING,
        providers: [{ connected: false }, { connected: true }],
      }).provider,
    ).toBe(true);
  });

  test('a keyless provider completes the step with no key saved (COR-2414)', () => {
    expect(firstRunProgress({ ...NOTHING, providers: [{ connected: true }] }).provider).toBe(true);
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
  });

  test('is not lost to storage that throws', () => {
    expect(readAssistantChosen(storageOf({}, { read: true }))).toBe(false);
    expect(readSaidHello(storageOf({}, { read: true }))).toBe(false);
    expect(() => writeAssistantChosen(storageOf({}, { write: true }))).not.toThrow();
    expect(() => writeSaidHello(storageOf({}, { write: true }))).not.toThrow();
  });
});
