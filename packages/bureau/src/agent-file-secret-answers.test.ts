/**
 * COR-1920 on a file agent (merged with COR-1913): the per-run toolbox the catalog builds for a file
 * agent carries the Bureau's secret resolver, so a tool that declares `acceptsSecrets` receives the
 * plaintext of a secret answer through `{ secretRef }` while the run, its events, and every write
 * to storage hold only the reference, and a tool that does not declare it is refused.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateEncryptionKey } from '@lostgradient/cryptography';
import type { GenerateFunction } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { agentFileDirectory } from './sources/agent-file-directory';
import { waitForCondition } from './test';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import { type FileBureauHarness, startFileBureau } from './testing/agent-file-bureau.test-support';

const SECRET = 'pw-file-agent-plaintext-sentinel';
const PRINCIPAL = 'api-key:tester';
const decoder = new TextDecoder('utf-8', { fatal: false });

/** Keeps every value ever written, so a value written and later deleted is scanned too. */
class RecordingStorage extends MemoryStorage {
  readonly written: string[] = [];

  override async put(key: string, value: Uint8Array): Promise<void> {
    this.written.push(`${key}=${decoder.decode(value)}`);
    return super.put(key, value);
  }

  override async batch(operations: Parameters<MemoryStorage['batch']>[0]): Promise<void> {
    this.record(operations);
    return super.batch(operations);
  }

  override async conditionalBatch(
    ...[conditions, operations]: Parameters<MemoryStorage['conditionalBatch']>
  ): ReturnType<MemoryStorage['conditionalBatch']> {
    this.record(operations);
    return super.conditionalBatch(conditions, operations);
  }

  private record(
    operations: ReadonlyArray<{ readonly key: string; readonly value?: unknown }>,
  ): void {
    for (const operation of operations) {
      if (operation.value instanceof Uint8Array) {
        this.written.push(`${operation.key}=${decoder.decode(operation.value)}`);
      }
    }
  }
}

const received: string[] = [];
const peeked: unknown[] = [];

const useSecret = createTool({
  name: 'use-secret',
  description: 'Uses a credential.',
  input: z.object({ credential: z.string() }),
  // Read-only, so a file agent's default `toolApproval` lets the call run.
  metadata: { acceptsSecrets: true, readOnly: true },
  async execute({ credential }) {
    received.push(credential);
    return { used: true };
  },
});

const peek = createTool({
  name: 'peek',
  description: 'Does not declare acceptsSecrets.',
  input: z.object({ credential: z.unknown() }),
  metadata: { readOnly: true },
  async execute({ credential }) {
    peeked.push(credential);
    return { peeked: true };
  },
});

const roots: string[] = [];
const harnesses: FileBureauHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  received.length = 0;
  peeked.length = 0;
});

describe('a secret answer on a file agent’s run', () => {
  it('reaches a declaring tool as plaintext, refuses an undeclared one, and is stored nowhere', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bureau-file-secret-'));
    roots.push(directory);
    const storage = new RecordingStorage();
    const modelMessages: string[] = [];
    const toolResults: string[] = [];
    const frames: string[] = [];
    let secretRef: string | undefined;

    const generate: GenerateFunction = async ({ step, conversation }) => {
      const messages = conversation.getMessages();
      modelMessages.push(JSON.stringify(messages));
      if (step === 0) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'ask-1',
              name: 'requestHumanInput',
              arguments: {
                signalName: 'login',
                prompt: 'Sign in',
                answerSchema: {
                  type: 'object',
                  properties: {
                    user: { type: 'string' },
                    password: { type: 'string', writeOnly: true, 'x-secret': true, minLength: 8 },
                  },
                  required: ['user', 'password'],
                  additionalProperties: false,
                },
              },
            },
          ],
        };
      }
      const results = messages.filter((message) => message.toolResult !== undefined);
      if (results.some((message) => message.toolResult?.callId === 'use-1')) {
        toolResults.push(JSON.stringify(results.map((message) => message.toolResult)));
        return { content: 'thanks', toolCalls: [] };
      }
      const answer = messages
        .map((message) => (typeof message.content === 'string' ? message.content : ''))
        .find((content) => content.startsWith('[signal:login] '));
      const parsed = JSON.parse(answer?.slice('[signal:login] '.length) ?? 'null') as {
        password: { secretRef: string };
      };
      secretRef = parsed.password.secretRef;
      return {
        content: '',
        toolCalls: [
          { id: 'use-1', name: 'use-secret', arguments: { credential: parsed.password } },
          { id: 'peek-1', name: 'peek', arguments: { credential: parsed.password } },
        ],
      };
    };

    const harness = await startFileBureau({
      directory,
      overrides: {
        storage,
        answerEncryption: { current: await generateEncryptionKey() },
        agentSource: agentFileDirectory(directory, {
          tools: { 'use-secret': useSecret, peek },
        }),
        models: { generate: () => generate },
      },
    });
    harnesses.push(harness);
    const unsubscribe = harness.bureau.frames((frame) => frames.push(JSON.stringify(frame)));
    await harness.put(
      'helper.md',
      agentFileText({ model: KNOWN_MODEL, tools: '[use-secret, peek]' }),
    );
    await harness.bureau.agents.refresh();

    const run = await harness.bureau.tasks.start('helper', 'sign me in', { principal: PRINCIPAL });
    await waitForCondition(
      () => harness.bureau.reviews.list().some((review) => review.runId === run.id),
      'expected the run to park on its question',
    );
    const receipt = await harness.bureau.tasks.respond({
      principal: PRINCIPAL,
      taskId: run.id,
      messageId: 'answer-1',
      data: { user: 'ada', password: SECRET },
    });
    expect(receipt).toMatchObject({ kind: 'human-wait', receipt: 'applied' });
    await waitForCondition(
      () => toolResults.length > 0 && harness.bureau.tasks.detail(run.id)?.status !== 'running',
      'expected the run to use the secret and finish',
    );
    await harness.bureau.tasks.wait(run.id);
    unsubscribe();

    // The declaring tool received the plaintext through the substitution.
    expect(received).toEqual([SECRET]);
    // The undeclared tool received nothing, and the model was told why.
    expect(peeked).toEqual([]);
    expect(toolResults.join('\n')).toContain('secret-not-accepted');
    expect(secretRef).toMatch(/^human-wait:.+\/password$/);

    // Only the reference is anywhere the run recorded or exposed.
    const written = storage.written.join('\n');
    expect(written).toContain(secretRef ?? '\u0000');
    const places: Record<string, string> = {
      'a value ever written to storage': written,
      'the replayed workflow': JSON.stringify(await harness.bureau.tasks.workflow(run.id)),
      'the run detail': JSON.stringify(harness.bureau.tasks.detail(run.id) ?? null),
      'the run events': frames.join('\n'),
      "the model's messages": modelMessages.join('\n'),
      'the tool results the model read': toolResults.join('\n'),
    };
    for (const [where, text] of Object.entries(places)) {
      expect(text.includes(SECRET), `${where} holds the plaintext`).toBe(false);
    }
  });
});
