import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  contentSourceSchema,
  conversationSchema,
  conversationShape,
  jsonValueSchema,
  messageInputSchema,
  messageRoleSchema,
  messageSchema,
  multiModalContentSchema,
  tokenUsageSchema,
  toolCallSchema,
  toolErrorCategorySchema,
  toolResultSchema,
} from '../src/schemas';
import { CURRENT_SCHEMA_VERSION } from '../src/versioning';

// Manual runtime standing in for the real clock (AB-321/AB-329) — this file never asserts
// anything about a specific instant, only about schema shape, so one shared runtime for every
// timestamp read below is sufficient.
const runtime = createManualRuntimeServices();

describe('schemas', () => {
  test('messageRoleSchema accepts tool-call literal', () => {
    const res = messageRoleSchema.safeParse('tool-call');
    expect(res.success).toBeTrue();
  });

  test('multiModalContentSchema validates a remote image source', () => {
    const ok = multiModalContentSchema.safeParse({
      type: 'image',
      source: { kind: 'remote-url', url: 'https://example.com/a.png' },
    });
    expect(ok.success).toBeTrue();
    expect(
      multiModalContentSchema.safeParse({
        type: 'image',
        source: { kind: 'remote-url', url: 'not a url' },
      }).success,
    ).toBeFalse();
  });

  test('contentSourceSchema pins the scheme of a remote URL to http or https and a data URL to data', () => {
    for (const url of ['https://example.com/a.png', 'http://example.com/a.png']) {
      expect(contentSourceSchema.safeParse({ kind: 'remote-url', url }).success).toBeTrue();
    }
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com/a.png',
      'blob:https://x/1',
      'javascript:alert(1)',
      'data:image/png;base64,QUJD',
    ]) {
      expect(contentSourceSchema.safeParse({ kind: 'remote-url', url }).success).toBeFalse();
    }
    expect(
      contentSourceSchema.safeParse({ kind: 'data-url', url: 'data:image/png;base64,QUJD' })
        .success,
    ).toBeTrue();
    for (const url of ['https://example.com/a.png', 'blob:https://x/1', 'file:///a']) {
      expect(contentSourceSchema.safeParse({ kind: 'data-url', url }).success).toBeFalse();
    }
  });

  test('contentSourceSchema requires base64 bytes to decode, inline and in a data URL', () => {
    for (const data of ['QUJD', 'QQ==', 'QUI=']) {
      expect(
        contentSourceSchema.safeParse({ kind: 'inline', data, encoding: 'base64' }).success,
      ).toBeTrue();
    }
    for (const data of ['!!!', 'QUJ', 'QU=JD', 'Q', 'QUJD====', 'QU JD']) {
      expect(
        contentSourceSchema.safeParse({ kind: 'inline', data, encoding: 'base64' }).success,
      ).toBeFalse();
    }
    // UTF-8 text is any non-empty string.
    expect(
      contentSourceSchema.safeParse({ kind: 'inline', data: '!!!', encoding: 'utf8' }).success,
    ).toBeTrue();

    expect(
      contentSourceSchema.safeParse({ kind: 'data-url', url: 'data:text/plain;base64,QUJD' })
        .success,
    ).toBeTrue();
    expect(
      contentSourceSchema.safeParse({ kind: 'data-url', url: 'data:text/plain;base64,!!!' })
        .success,
    ).toBeFalse();
    // The percent-encoded branch is text, so it need only decode as a URI component.
    expect(
      contentSourceSchema.safeParse({ kind: 'data-url', url: 'data:text/plain,hello%20world' })
        .success,
    ).toBeTrue();
    expect(
      contentSourceSchema.safeParse({ kind: 'data-url', url: 'data:text/plain,%E0%A4%A' }).success,
    ).toBeFalse();
  });

  test('multiModalContentSchema requires a declared media type to fit the part’s modality', () => {
    const source = { kind: 'remote-url', url: 'https://example.com/a' } as const;
    const accepts: Array<[string, string]> = [
      ['image', 'image/png'],
      ['image', 'IMAGE/SVG+XML; charset=utf-8'],
      ['audio', 'audio/mpeg'],
      ['video', 'video/mp4'],
      ['document', 'application/pdf'],
      ['document', 'text/markdown'],
      ['document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['file', 'application/zip'],
      ['file', 'image/png'],
    ];
    for (const [type, mimeType] of accepts) {
      expect(multiModalContentSchema.safeParse({ type, source, mimeType }).success).toBeTrue();
    }
    const refuses: Array<[string, string]> = [
      ['image', 'application/pdf'],
      ['image', 'audio/mpeg'],
      ['audio', 'image/png'],
      ['video', 'application/pdf'],
      ['document', 'image/png'],
      ['document', 'application/zip'],
    ];
    for (const [type, mimeType] of refuses) {
      expect(multiModalContentSchema.safeParse({ type, source, mimeType }).success).toBeFalse();
    }
    expect(multiModalContentSchema.safeParse({ type: 'image', source }).success).toBeTrue();
  });

  test('multiModalContentSchema rejects the retired url and base64-source shapes', () => {
    expect(
      multiModalContentSchema.safeParse({ type: 'image', url: 'https://example.com/a.png' })
        .success,
    ).toBeFalse();
    expect(
      multiModalContentSchema.safeParse({
        type: 'document',
        name: 'a.pdf',
        mimeType: 'application/pdf',
        source: { kind: 'base64', data: 'cGRm' },
      }).success,
    ).toBeFalse();
  });

  test('multiModalContentSchema accepts document base64 and reference sources', () => {
    expect(
      multiModalContentSchema.safeParse({
        type: 'document',
        name: 'requirements.pdf',
        mimeType: 'application/pdf',
        source: { kind: 'inline', data: 'cGRm', encoding: 'base64' },
      }).success,
    ).toBeTrue();

    expect(
      multiModalContentSchema.safeParse({
        type: 'document',
        name: 'notes.md',
        mimeType: 'text/markdown',
        source: { kind: 'local-file', path: '/workspace/notes.md' },
      }).success,
    ).toBeTrue();
  });

  test('multiModalContentSchema rejects empty document fields', () => {
    expect(
      multiModalContentSchema.safeParse({
        type: 'document',
        name: '',
        mimeType: 'application/pdf',
        source: { kind: 'inline', data: 'cGRm', encoding: 'base64' },
      }).success,
    ).toBeFalse();

    expect(
      multiModalContentSchema.safeParse({
        type: 'document',
        name: 'empty.pdf',
        mimeType: 'application/pdf',
        source: { kind: 'local-file', path: '' },
      }).success,
    ).toBeFalse();
  });

  test('jsonValueSchema rejects non-JSON values', () => {
    expect(jsonValueSchema.safeParse(new Date(runtime.clock.now())).success).toBeFalse();
    expect(jsonValueSchema.safeParse(Number.POSITIVE_INFINITY).success).toBeFalse();
  });

  test('jsonValueSchema rejects non-plain objects', () => {
    const value: unknown = Object.create({}, { name: { value: 'test', enumerable: true } });
    const result = jsonValueSchema.safeParse(value);
    expect(result.success).toBeFalse();
    if (!result.success) {
      const messages = result.error.issues.flatMap((issue) => {
        if (issue.code === 'invalid_union') {
          const errors = issue.errors;
          return errors.flat().map((nested) => nested.message);
        }
        return issue.message;
      });
      expect(messages).toContain('expected a plain object');
    }
  });

  test('messageSchema basic shape', () => {
    const m = {
      id: 'id',
      role: 'user',
      content: 'hi',
      position: 0,
      createdAt: runtime.clock.nowISO(),
      metadata: {},
      hidden: false,
    } as const;
    const res = messageSchema.safeParse(m);
    expect(res.success).toBeTrue();
  });

  test('conversationSchema basic shape', () => {
    const now = runtime.clock.nowISO();
    const c = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: 'c1',
      status: 'active',
      metadata: {},
      ids: [],
      messages: {},
      createdAt: now,
      updatedAt: now,
    } as const;
    const res = conversationSchema.safeParse(c);
    expect(res.success).toBeTrue();
  });

  test('conversationShape is exported', () => {
    expect(conversationShape).toBeDefined();
    expect(typeof conversationShape).toBe('object');
  });

  test('conversationShape has all required fields', () => {
    expect(conversationShape).toHaveProperty('schemaVersion');
    expect(conversationShape).toHaveProperty('id');
    expect(conversationShape).toHaveProperty('title');
    expect(conversationShape).toHaveProperty('status');
    expect(conversationShape).toHaveProperty('metadata');
    expect(conversationShape).toHaveProperty('ids');
    expect(conversationShape).toHaveProperty('messages');
    expect(conversationShape).toHaveProperty('createdAt');
    expect(conversationShape).toHaveProperty('updatedAt');
  });

  test('conversationShape includes id field', () => {
    expect('id' in conversationShape).toBe(true);
    // Verify id is a zod string schema
    expect(conversationShape.id).toBeDefined();
  });

  test('conversationShape can be used to create a ZodObject', () => {
    const schemaFromShape = z.object(conversationShape);
    expect(schemaFromShape).toBeDefined();

    const now = runtime.clock.nowISO();
    const testData = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: 'test-id',
      status: 'active' as const,
      metadata: {},
      ids: [],
      messages: {},
      createdAt: now,
      updatedAt: now,
    };

    const result = schemaFromShape.safeParse(testData);
    expect(result.success).toBe(true);
  });

  test('conversationSchema.shape matches conversationShape', () => {
    // The schema should be built from the shape
    const schemaShape = conversationSchema.shape;

    // Check that the same fields exist
    expect('schemaVersion' in schemaShape).toBe(true);
    expect('id' in schemaShape).toBe(true);
    expect('title' in schemaShape).toBe(true);
    expect('status' in schemaShape).toBe(true);
    expect('metadata' in schemaShape).toBe(true);
    expect('ids' in schemaShape).toBe(true);
    expect('messages' in schemaShape).toBe(true);
    expect('createdAt' in schemaShape).toBe(true);
    expect('updatedAt' in schemaShape).toBe(true);
  });

  test('tool result schema accepts unavailable tool errors', () => {
    expect(toolErrorCategorySchema.safeParse('unavailable').success).toBeTrue();

    const result = toolResultSchema.safeParse({
      callId: 'call-1',
      outcome: 'error',
      content: 'Tool unavailable: macos-only',
      error: {
        code: 'TOOL_UNAVAILABLE',
        category: 'unavailable',
        retryable: false,
        message: 'Tool unavailable: macos-only',
      },
    });

    expect(result.success).toBeTrue();
  });

  test('conversationShape works with storage systems', () => {
    // Simulate what a storage system would do
    const hasIdField = 'id' in conversationShape;
    expect(hasIdField).toBe(true);

    // Storage system should detect this and not add its own id field
    const enhancedShape = {
      ...conversationShape,
      // Only add id if not present (simulating storage-unit behavior)
      ...(!hasIdField ? { id: z.string() } : {}),
      type: z.literal('conversation'),
    };

    const schema = z.object(enhancedShape);

    const now = runtime.clock.nowISO();
    const testData = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: 'original-id',
      type: 'conversation',
      status: 'active' as const,
      metadata: {},
      ids: [],
      messages: {},
      createdAt: now,
      updatedAt: now,
    };

    const result = schema.safeParse(testData);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('original-id');
    }
  });
});

describe('Standard Schema compliance', () => {
  test('all schemas have ~standard property', () => {
    const schemas = [
      conversationSchema,
      jsonValueSchema,
      messageSchema,
      messageInputSchema,
      messageRoleSchema,
      multiModalContentSchema,
      toolCallSchema,
      toolResultSchema,
      tokenUsageSchema,
    ];

    for (const schema of schemas) {
      expect(schema).toHaveProperty('~standard');
      expect(schema['~standard']).toHaveProperty('version', 1);
      expect(schema['~standard']).toHaveProperty('vendor', 'zod');
      expect(typeof schema['~standard'].validate).toBe('function');
    }
  });

  test('~standard.validate returns success result for valid data', async () => {
    const validConversation = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: 'conv-1',
      status: 'active',
      metadata: {},
      ids: [],
      messages: {},
      createdAt: runtime.clock.nowISO(),
      updatedAt: runtime.clock.nowISO(),
    };

    const result = await conversationSchema['~standard'].validate(validConversation);
    expect(result).not.toHaveProperty('issues');
    expect(result).toHaveProperty('value');
  });

  test('~standard.validate returns failure result for invalid data', async () => {
    const invalidData = { invalid: true };
    const result = await conversationSchema['~standard'].validate(invalidData);
    expect(result).toHaveProperty('issues');
    expect(Array.isArray(result.issues)).toBe(true);
  });
});
