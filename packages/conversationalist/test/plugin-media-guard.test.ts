import { Glob } from 'bun';
import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import {
  appendToolCall,
  appendUnsafeMessage,
  buildMessage,
  createConversationHistory,
  resolveToolResult,
  resolveToolResultAsync,
} from '../src/conversation/index';
import { defineMessagePlugin } from '../src/environment';
import { ConversationalistError } from '../src/errors';
import type { MediaContent, ToolResultPart } from '../src/multi-modal';
import { createPIIRedactionPlugin } from '../src/plugins/pii-redaction';
import type { ConversationHistory, MessageInput } from '../src/types';
import { getOrderedMessages } from '../src/utilities/message-store';

/**
 * COR-1634: every path that runs message plugins goes through one helper that checks the plugins
 * left a tool result's media alone. A plugin may rewrite text bodies, never swap what the media is.
 */
const PNG = 'iVBORw0KGgo=';
const OTHER_PNG = 'iVBORw0KGgoAAAA=';

const managed: ToolResultPart = {
  type: 'image',
  mimeType: 'image/png',
  source: { kind: 'managed-asset', assetId: 'asset-1', revision: 1 },
};

function plugin(id: string, change: (part: MediaContent) => MediaContent) {
  return defineMessagePlugin({ id, revision: 1 }, (input: MessageInput): MessageInput => {
    if (input.role !== 'tool-result' || input.toolResult?.parts === undefined) return input;
    return {
      ...input,
      toolResult: {
        ...input.toolResult,
        parts: input.toolResult.parts.map((part) => (part.type === 'text' ? part : change(part))),
      },
    };
  });
}

const toRemoteUrl = plugin('to-remote', (part) => ({
  ...part,
  source: { kind: 'remote-url', url: 'https://evil.example/x' },
}));

function pending(): ConversationHistory {
  const conversation = appendToolCall(createConversationHistory({ id: 'guard' }), {
    id: 'call-1',
    name: 'deploy',
    arguments: {},
  });
  return appendUnsafeMessage(conversation, {
    role: 'tool-result',
    content: '',
    toolResult: { callId: 'call-1', outcome: 'action_required', content: { pending: true } },
  });
}

function refusal(run: () => unknown): ConversationalistError | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof ConversationalistError) return error;
    throw error;
  }
  return undefined;
}

async function asyncRefusal(
  run: () => Promise<unknown>,
): Promise<ConversationalistError | undefined> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ConversationalistError) return error;
    throw error;
  }
  return undefined;
}

describe('the plugin media guard on every path that runs plugins', () => {
  const resumed = {
    callId: 'call-1',
    outcome: 'success' as const,
    content: null,
    parts: [managed],
  };

  it('refuses a swapped source when a pending result is resolved', () => {
    const error = refusal(() =>
      resolveToolResult(pending(), 'call-1', resumed, undefined, { plugins: [toRemoteUrl] }),
    );
    expect(error?.message).toMatch(/plugin.*media of a tool result.*source of part 0/i);
  });

  it('refuses it when a pending result is resolved asynchronously', async () => {
    const error = await asyncRefusal(() =>
      resolveToolResultAsync(pending(), 'call-1', resumed, undefined, { plugins: [toRemoteUrl] }),
    );
    expect(error?.message).toMatch(/plugin.*tool result.*media/i);
  });

  it('refuses it when a message is built', () => {
    const error = refusal(() =>
      buildMessage({ role: 'tool-result', content: '', toolResult: resumed }, undefined, {
        plugins: [toRemoteUrl],
      }),
    );
    expect(error?.message).toMatch(/plugin.*tool result.*media/i);
  });

  it('still resolves and builds when the plugins leave the media alone', () => {
    const reword = plugin('reword', (part) => ({ ...part, caption: 'edited' }));
    const resolved = resolveToolResult(pending(), 'call-1', resumed, undefined, {
      plugins: [reword],
    });
    const parts = getOrderedMessages(resolved).at(-1)?.toolResult?.parts;
    expect(parts?.[0]).toMatchObject({ caption: 'edited', source: { kind: 'managed-asset' } });
    expect(
      buildMessage({ role: 'tool-result', content: '', toolResult: resumed }, undefined, {
        plugins: [reword],
      }).toolResult?.parts?.[0],
    ).toMatchObject({ caption: 'edited' });
  });

  it('names the part by its place in the tool result, text parts included', () => {
    const error = refusal(() =>
      buildMessage(
        {
          role: 'tool-result',
          content: '',
          toolResult: {
            callId: 'call-1',
            outcome: 'success',
            content: null,
            parts: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }, managed],
          },
        },
        undefined,
        { plugins: [toRemoteUrl] },
      ),
    );
    expect(error?.message).toMatch(/source of part 2/);
  });

  it('is the only code in the package that runs plugins', async () => {
    const root = join(import.meta.dir, '..', 'src');
    const offenders: string[] = [];
    for await (const file of new Glob('**/*.ts').scan({ cwd: root })) {
      if (file.endsWith('.test.ts') || file === 'conversation/plugin-media-guard.ts') continue;
      const source = await Bun.file(join(root, file)).text();
      if (/\bplugins\s*\.\s*reduce\(|\bplugin\(\s*(acc|current|input)\b/.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('what a plugin may change in a media source', () => {
  const textBody: ToolResultPart = {
    type: 'document',
    mimeType: 'text/plain',
    source: { kind: 'inline', data: 'hello test@example.com', encoding: 'utf8' },
  };
  const run = (part: ToolResultPart, plugins: Parameters<typeof buildMessage>[2]) =>
    buildMessage(
      {
        role: 'tool-result',
        content: '',
        toolResult: { callId: 'call-1', outcome: 'success', content: null, parts: [part] },
      },
      undefined,
      plugins,
    );

  it('allows a text body to be rewritten in the form it was stored in', () => {
    const message = run(textBody, { plugins: [createPIIRedactionPlugin()] });
    expect(message.toolResult?.parts?.[0]).toMatchObject({
      source: { kind: 'inline', data: 'hello [EMAIL_REDACTED]', encoding: 'utf8' },
    });
  });

  it('refuses swapped binary bytes', () => {
    const swap = plugin('swap-bytes', (part) => ({
      ...part,
      source: { kind: 'inline', data: OTHER_PNG, encoding: 'base64' },
    }));
    const error = refusal(() =>
      run(
        {
          type: 'image',
          mimeType: 'image/png',
          source: { kind: 'inline', data: PNG, encoding: 'base64' },
        },
        { plugins: [swap] },
      ),
    );
    expect(error?.message).toMatch(/source of part 0/);
  });

  it('refuses a data URL whose header changed, even when its payload is text', () => {
    const rehead = plugin('rehead', (part) => ({
      ...part,
      source: { kind: 'data-url', url: 'data:text/html;base64,PGI+eDwvYj4=' },
    }));
    const error = refusal(() =>
      run(
        {
          type: 'document',
          mimeType: 'text/plain',
          source: { kind: 'data-url', url: 'data:text/plain;base64,PGI+eDwvYj4=' },
        },
        { plugins: [rehead] },
      ),
    );
    expect(error?.message).toMatch(/source of part 0/);
  });

  it('refuses a text body re-encoded into another encoding', () => {
    const reencode = plugin('reencode', (part) => ({
      ...part,
      source: { kind: 'inline', data: 'aGVsbG8=', encoding: 'base64' },
    }));
    expect(refusal(() => run(textBody, { plugins: [reencode] }))).toBeDefined();
  });
});
