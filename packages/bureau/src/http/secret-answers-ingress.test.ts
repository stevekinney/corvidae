/**
 * COR-1920 — a secret answer, given through each ingress (`bureau.reviews.resolve`,
 * `bureau.tasks.respond`, an AG-UI resume), is sealed before anything holds it. The model, the
 * conversation, the checkpoint, the replay, the run events, the audit trail, the command ledgers,
 * the AG-UI frames, and every key in storage hold the reference and never the plaintext, nor a
 * plain SHA-256 of it. A tool that declares `acceptsSecrets` in the run that asked reads it back;
 * an undeclared tool and a tool of another run are refused.
 */
import { EventType, type ResumeEntry } from '@ag-ui/core';
import {
  type EncryptionKey,
  generateEncryptionKey,
  sha256HexSync,
} from '@lostgradient/cryptography';
import {
  createAgent,
  type GenerateFunction,
  type HumanInputSchema,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage, type Storage } from '@lostgradient/storage';
import { createTool, createToolbox, type Toolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from '../agent-catalog';
import { createMemoryAssetStorage } from '../assets/storage';
import { canonicalJson, digestCommandPayload } from '../command-ledger.ts';
import { createBureau } from '../create-bureau.ts';
import {
  type AnswerEncryptionKeys,
  createSecretAnswerResolver,
  SECRET_ANSWER_KEY_PREFIX,
} from '../secret-answers.ts';
import { waitForCondition } from '../test';
import type { Bureau, PendingReview } from '../types.ts';
import { runAgentInput, startRequest } from './ag-ui-fixtures.test-support.ts';
import { readAgUiStream } from './ag-ui-stream.test-support.ts';
import { createBureauHandler } from './create-bureau-handler.ts';

/** A value no fixture or framework string could hold by chance. */
const SECRET = 'pw-7f3c9e1a-plaintext-sentinel';
const PRINCIPAL = 'api-key:tester';
const AGENT = 'default';

const secretSchema: HumanInputSchema = {
  type: 'object',
  properties: {
    user: { type: 'string' },
    password: { type: 'string', writeOnly: true, 'x-secret': true, minLength: 8 },
  },
  required: ['user', 'password'],
  additionalProperties: false,
};

/** Every form a leak of the secret could take: the text, and a plain SHA-256 of it or of the answer. */
function leakForms(): string[] {
  const answer = { user: 'ada', password: SECRET };
  return [
    SECRET,
    sha256HexSync(SECRET),
    sha256HexSync(JSON.stringify(SECRET)),
    sha256HexSync(canonicalJson(answer)),
    // What `review-decision:v1` and the `tasks.respond` ledger digested before COR-1920.
    digestCommandPayload({
      answer: undefined,
      data: canonicalJson(answer),
      decision: undefined,
      reason: undefined,
      signalName: undefined,
      callId: undefined,
    }),
  ];
}

function expectNoLeak(where: string, text: string): void {
  for (const form of leakForms()) expect(text.includes(form), `${where} holds ${form}`).toBe(false);
}

async function everyStoredKey(storage: Storage): Promise<Array<[string, string]>> {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const entries: Array<[string, string]> = [];
  for await (const [key, value] of storage.scan('')) entries.push([key, decoder.decode(value)]);
  return entries;
}

type Plan =
  | { readonly kind: 'ask' }
  /** Another run that tries to read a reference it was handed. */
  | { readonly kind: 'borrow'; readonly secretRef: string };

/** A Bureau whose agent asks for a secret, then hands the reference it was given to three tools. */
async function secretBureau() {
  const storage = new MemoryStorage();
  const keys: AnswerEncryptionKeys = { current: await generateEncryptionKey() };
  const seen = {
    plan: { kind: 'ask' } as Plan,
    /** Every message list the model was given, as JSON. */
    modelMessages: [] as string[],
    /** What the declaring tools received. */
    received: [] as string[],
    /** What the undeclared tool received. */
    peeked: [] as unknown[],
    /** The tool results the model read, as JSON. */
    toolResults: [] as string[],
    /** The reference the model found in the answer. */
    secretRef: undefined as string | undefined,
  };
  const useSecret = createTool({
    name: 'use-secret',
    description: 'Uses a credential.',
    input: z.object({ credential: z.string() }),
    metadata: { acceptsSecrets: true },
    async execute({ credential }) {
      seen.received.push(credential);
      return { used: true };
    },
  });
  const signIn = createTool({
    name: 'sign-in',
    description: 'Resolves a reference itself.',
    input: z.object({ reference: z.string() }),
    metadata: { acceptsSecrets: true },
    async execute({ reference }, context) {
      seen.received.push(await context.resolveSecret(reference));
      return { signedIn: true };
    },
  });
  const peek = createTool({
    name: 'peek',
    description: 'Does not declare acceptsSecrets.',
    input: z.object({ credential: z.unknown() }),
    async execute({ credential }) {
      seen.peeked.push(credential);
      return { peeked: true };
    },
  });
  const toolbox = createToolbox([useSecret, signIn, peek], {
    secretResolver: createSecretAnswerResolver({ storage, keys }),
  });

  const generate: GenerateFunction = async ({ step, conversation }) => {
    const messages = conversation.getMessages();
    seen.modelMessages.push(JSON.stringify(messages));
    const plan = seen.plan;
    if (plan.kind === 'borrow') {
      if (step > 0) return { content: 'done', toolCalls: [] };
      return {
        content: '',
        toolCalls: [
          {
            id: 'borrow-1',
            name: 'use-secret',
            arguments: { credential: { secretRef: plan.secretRef } },
          },
        ],
      };
    }
    if (step === 0) {
      return {
        content: '',
        toolCalls: [
          {
            id: 'ask-1',
            name: 'requestHumanInput',
            arguments: { signalName: 'login', prompt: 'Sign in', answerSchema: secretSchema },
          },
        ],
      };
    }
    const results = messages.filter((message) => message.toolResult !== undefined);
    if (results.some((message) => message.toolResult?.callId === 'use-1')) {
      seen.toolResults.push(JSON.stringify(results.map((message) => message.toolResult)));
      return { content: 'thanks', toolCalls: [] };
    }
    const answer = messages
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .find((content) => content.startsWith('[signal:login] '));
    const parsed = JSON.parse(answer?.slice('[signal:login] '.length) ?? 'null') as {
      password: { secretRef: string };
    };
    seen.secretRef = parsed.password.secretRef;
    return {
      content: '',
      toolCalls: [
        { id: 'use-1', name: 'use-secret', arguments: { credential: parsed.password } },
        { id: 'sign-1', name: 'sign-in', arguments: { reference: parsed.password.secretRef } },
        { id: 'peek-1', name: 'peek', arguments: { credential: parsed.password } },
      ],
    };
  };

  const frames: string[] = [];
  const bureau = (await createBureau<AgentDefinitions>({
    id: 'secret-answers',
    agents: {
      [AGENT]: createAgent({
        name: AGENT,
        generate,
        toolbox: toolbox as unknown as Toolbox,
        stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
      }),
    },
    storage,
    durable: true,
    assets: { storage: createMemoryAssetStorage() },
    answerEncryption: keys,
  })) as unknown as Bureau;
  const unsubscribe = bureau.frames((frame) => frames.push(JSON.stringify(frame)));
  const handler = createBureauHandler(bureau, {
    unauthenticatedAccess: 'allow',
    a2aAgents: [AGENT],
    agUi: {},
  });

  async function park(): Promise<{ runId: string; review: PendingReview }> {
    seen.plan = { kind: 'ask' };
    const run = await bureau.tasks.start(AGENT, 'sign me in', { principal: PRINCIPAL });
    await waitForCondition(
      () => bureau.reviews.list().some((review) => review.runId === run.id),
      'expected the run to park on its question',
    );
    return {
      runId: run.id,
      review: bureau.reviews.list().find((review) => review.runId === run.id)!,
    };
  }

  async function settled(runId: string): Promise<void> {
    await waitForCondition(
      () => seen.toolResults.length > 0 && bureau.tasks.detail(runId)?.status !== 'running',
      'expected the run to use the secret and finish',
    );
    await bureau.tasks.wait(runId);
  }

  /** Every place the secret must not be, scanned. */
  async function scan(runId: string, extra: Record<string, string> = {}): Promise<void> {
    const stored = await everyStoredKey(storage);
    for (const [key, value] of stored) expectNoLeak(`storage key ${key}`, `${key}\n${value}`);
    // The scan reads what was stored: the reference the run was given is there to be found.
    expect(stored.some(([, value]) => value.includes(seen.secretRef ?? '\u0000'))).toBe(true);
    const audit = (await bureau.internals.auditTrail?.query({ runId })) ?? [];
    expect(audit.length).toBeGreaterThan(0);
    expectNoLeak('the audit trail', JSON.stringify(audit));
    expectNoLeak('the replayed workflow', JSON.stringify(await bureau.tasks.workflow(runId)));
    expectNoLeak('the run detail', JSON.stringify(bureau.tasks.detail(runId) ?? null));
    expectNoLeak('the run events', frames.join('\n'));
    expectNoLeak("the model's messages", seen.modelMessages.join('\n'));
    expectNoLeak('the tool results the model read', seen.toolResults.join('\n'));
    for (const [where, text] of Object.entries(extra)) expectNoLeak(where, text);
  }

  /** What the run's tools received and returned once the answer was in. */
  function expectToolOutcomes(): void {
    // The declaring tools got the plaintext: one through its arguments, one through resolveSecret.
    expect(seen.received).toEqual([SECRET, SECRET]);
    // The undeclared tool got nothing, and the model was told why.
    expect(seen.peeked).toEqual([]);
    expect(seen.toolResults.join('\n')).toContain('secret-not-accepted');
    // The model saw the reference, named after the review and the field.
    expect(seen.secretRef).toMatch(/^human-wait:.+\/password$/);
  }

  /** Every secret-answer record carries its owner and the run that asked. */
  async function expectRecords(runId: string, owner = PRINCIPAL): Promise<void> {
    const records = (await everyStoredKey(storage))
      .filter(([key]) => key.startsWith(SECRET_ANSWER_KEY_PREFIX))
      .map(([, value]) => JSON.parse(value) as Record<string, unknown>);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ version: 1, owner, runId });
    expect(records[0]?.['secretRef']).toBe(seen.secretRef);
  }

  /** The audit entry names the field and a digest of its ciphertext, and keeps the secret fields. */
  async function expectAudit(runId: string): Promise<void> {
    const audit = (await bureau.internals.auditTrail?.query({ runId })) ?? [];
    const approved = audit.find((record) => record.type === 'review.human-wait.approved');
    const detail = approved?.detail as {
      review: { secretFields?: string[] };
      secretAnswers?: Array<{ field: string; ciphertextDigest: string }>;
    };
    expect(detail.review.secretFields).toEqual(['/password']);
    expect(detail.secretAnswers).toEqual([
      { field: '/password', ciphertextDigest: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
  }

  async function dispose(): Promise<void> {
    unsubscribe();
    await bureau.dispose();
  }

  return {
    bureau,
    storage,
    keys,
    toolbox,
    seen,
    handler,
    park,
    settled,
    scan,
    expectToolOutcomes,
    expectRecords,
    expectAudit,
    dispose,
  };
}

describe('a secret answer through bureau.reviews.resolve', () => {
  it('reaches only the declaring tools of the asking run, and is kept nowhere in plaintext', async () => {
    const harness = await secretBureau();
    try {
      const { runId, review } = await harness.park();

      const resolved = await harness.bureau.reviews.resolve({
        id: review.id,
        decision: 'approve',
        principal: PRINCIPAL,
        payload: { user: 'ada', password: SECRET },
      });
      expect(resolved).toMatchObject({ kind: 'human-wait', decision: 'approve' });
      await harness.settled(runId);

      harness.expectToolOutcomes();
      await harness.expectRecords(runId);
      await harness.expectAudit(runId);
      await harness.scan(runId);
    } finally {
      await harness.dispose();
    }
  });

  it('checks the plaintext against the schema before sealing it', async () => {
    const harness = await secretBureau();
    try {
      const { review } = await harness.park();

      const refused = await harness.bureau.reviews
        .resolve({
          id: review.id,
          decision: 'approve',
          principal: PRINCIPAL,
          payload: { user: 'ada', password: 'short' },
        })
        .then(
          () => undefined,
          (error: unknown) => error as Error & { issues?: unknown[] },
        );

      expect(refused?.issues).toEqual([
        expect.objectContaining({ path: ['password'], code: 'minLength' }),
      ]);
      expect(refused?.message).not.toContain('short');
      expect(harness.bureau.reviews.list().map((pending) => pending.id)).toEqual([review.id]);
    } finally {
      await harness.dispose();
    }
  });

  it('refuses a sealed answer copied from another question', async () => {
    const harness = await secretBureau();
    try {
      const { review } = await harness.park();

      const refused = await harness.bureau.reviews
        .resolve({
          id: review.id,
          decision: 'approve',
          principal: PRINCIPAL,
          payload: {
            user: 'ada',
            password: {
              secretRef: `${review.id}/password`,
              encrypted: { version: 1, ciphertext: 'AAAA', iv: 'AAAAAAAAAAAAAAAA', keyId: 'x' },
            },
          },
        })
        .then(
          () => undefined,
          (error: unknown) => error as Error & { issues?: unknown[] },
        );

      expect(refused?.issues).toEqual([expect.objectContaining({ code: 'secret' })]);
      expect(harness.bureau.reviews.list()).toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });

  it('refuses another run’s tool, and a deleted key leaves the answer secret-unavailable', async () => {
    const harness = await secretBureau();
    try {
      const { runId, review } = await harness.park();
      await harness.bureau.reviews.resolve({
        id: review.id,
        decision: 'approve',
        principal: PRINCIPAL,
        payload: { user: 'ada', password: SECRET },
      });
      await harness.settled(runId);
      const secretRef = harness.seen.secretRef!;

      // Another run of the same agent is handed the reference and calls the declaring tool.
      harness.seen.plan = { kind: 'borrow', secretRef };
      harness.seen.received.length = 0;
      const other = await harness.bureau.tasks.start(AGENT, 'borrow', { principal: PRINCIPAL });
      await harness.bureau.tasks.wait(other.id);
      expect(harness.seen.received).toEqual([]);
      expect(harness.seen.modelMessages.at(-1)).toContain('secret-unavailable');

      // The asking run's own id still reads it, through a toolbox over the same storage and keys.
      const call = {
        id: 'direct-1',
        name: 'use-secret',
        arguments: { credential: { secretRef } },
      };
      const allowed = await harness.toolbox.execute(call, {
        executionContext: { parentRunId: runId },
      });
      expect(allowed.outcome).toBe('success');
      expect(harness.seen.received).toEqual([SECRET]);

      // With the key gone, the same call is secret-unavailable.
      const forgetful = createToolbox(harness.toolbox.tools(), {
        secretResolver: createSecretAnswerResolver({
          storage: harness.storage,
          keys: { current: await generateEncryptionKey() },
        }),
      });
      const lost = await forgetful.execute(call, { executionContext: { parentRunId: runId } });
      expect(lost.outcome).toBe('error');
      expect(JSON.stringify(lost)).toContain('secret-unavailable');
      expect(harness.seen.received).toEqual([SECRET]);
    } finally {
      await harness.dispose();
    }
  });

  it('keeps earlier answers readable after the key is rotated', async () => {
    const harness = await secretBureau();
    try {
      const { runId, review } = await harness.park();
      await harness.bureau.reviews.resolve({
        id: review.id,
        decision: 'approve',
        principal: PRINCIPAL,
        payload: { user: 'ada', password: SECRET },
      });
      await harness.settled(runId);
      const retired: EncryptionKey = harness.keys.current;
      const rotated = createToolbox(harness.toolbox.tools(), {
        secretResolver: createSecretAnswerResolver({
          storage: harness.storage,
          keys: {
            current: await generateEncryptionKey(),
            retired: (keyId) => (keyId === retired.keyId ? retired : undefined),
          },
        }),
      });
      harness.seen.received.length = 0;

      const result = await rotated.execute(
        {
          id: 'rotated-1',
          name: 'use-secret',
          arguments: { credential: { secretRef: harness.seen.secretRef! } },
        },
        { executionContext: { parentRunId: runId } },
      );

      expect(result.outcome).toBe('success');
      expect(harness.seen.received).toEqual([SECRET]);
    } finally {
      await harness.dispose();
    }
  });

  it('answers a same-decision retry as the first resolve, and digests the reference, not the secret', async () => {
    const harness = await secretBureau();
    try {
      const { runId, review } = await harness.park();
      const input = {
        id: review.id,
        decision: 'approve' as const,
        principal: PRINCIPAL,
        payload: { user: 'ada', password: SECRET },
      };
      // Two resolves at once: one claims and delivers, the other is the same decision.
      const [first, second] = await Promise.allSettled([
        harness.bureau.reviews.resolve(input),
        harness.bureau.reviews.resolve(input),
      ]);
      expect(first.status).toBe('fulfilled');
      const refusal = second.status === 'rejected' ? String(second.reason) : '';
      // A concurrent same-decision caller is told it is already being resolved, never that a
      // different decision won.
      expect(refusal).not.toContain('different resolver');
      await harness.settled(runId);

      await harness.expectRecords(runId);
      await harness.scan(runId);
    } finally {
      await harness.dispose();
    }
  });
});

describe('a secret answer through bureau.tasks.respond', () => {
  it('is sealed before the ledger keeps it, and a retry gets the same receipt', async () => {
    const harness = await secretBureau();
    try {
      const { runId } = await harness.park();
      const command = {
        principal: PRINCIPAL,
        taskId: runId,
        messageId: 'answer-1',
        data: { user: 'ada', password: SECRET },
      };

      const receipt = await harness.bureau.tasks.respond(command);
      expect(receipt).toMatchObject({ kind: 'human-wait', receipt: 'applied' });
      await harness.settled(runId);
      // A retry after the review closed reads its secret fields from the audit trail and digests
      // the command the same way.
      expect(await harness.bureau.tasks.respond(command)).toEqual(receipt);

      harness.expectToolOutcomes();
      await harness.expectRecords(runId);
      await harness.expectAudit(runId);
      await harness.scan(runId);
    } finally {
      await harness.dispose();
    }
  });

  it('seals an answer given as text', async () => {
    const harness = await secretBureau();
    try {
      const { runId } = await harness.park();

      await harness.bureau.tasks.respond({
        principal: PRINCIPAL,
        taskId: runId,
        messageId: 'answer-1',
        answer: JSON.stringify({ user: 'ada', password: SECRET }),
      });
      await harness.settled(runId);

      harness.expectToolOutcomes();
      await harness.scan(runId);
    } finally {
      await harness.dispose();
    }
  });
});

describe('a secret answer through an AG-UI resume', () => {
  it('is sealed, the frames show the reference, and a retry streams instead of conflicting', async () => {
    const harness = await secretBureau();
    try {
      const started = await readAgUiStream(
        await harness.handler(startRequest(runAgentInput(), {}, AGENT)),
      );
      const finished = started.at(-1)!.event as {
        outcome: { type: string; interrupts: Array<{ id: string }> };
      };
      const interruptId = finished.outcome.interrupts[0]!.id;
      const review = harness.bureau.reviews.list()[0]!;
      const entry: ResumeEntry = {
        interruptId,
        status: 'resolved',
        payload: {
          decision: 'approve',
          answer: JSON.stringify({ user: 'ada', password: SECRET }),
        },
      };
      const resume = () =>
        harness.handler(
          startRequest(
            runAgentInput({ runId: 'client-run-2', messages: [], resume: [entry] }),
            {},
            AGENT,
          ),
        );

      const resumed = await readAgUiStream(await resume());
      expect(resumed.at(-1)!.event).toMatchObject({
        type: EventType.RUN_FINISHED,
        outcome: { type: 'success' },
      });
      await harness.settled(review.runId);
      const retried = await readAgUiStream(await resume());
      expect(JSON.stringify(retried)).not.toContain('RESUME_CONFLICT');
      expect(JSON.stringify(resumed)).toContain('secretRef');

      harness.expectToolOutcomes();
      // An unauthenticated AG-UI caller is the local anonymous principal, who owns the run.
      await harness.expectRecords(review.runId, 'anonymous:local');
      await harness.scan(review.runId, {
        'the AG-UI start frames': JSON.stringify(started),
        'the AG-UI resume frames': JSON.stringify(resumed),
        'the AG-UI retry frames': JSON.stringify(retried),
      });
    } finally {
      await harness.dispose();
    }
  });
});
