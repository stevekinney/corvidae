/**
 * COR-1548 — the page cannot import the Bureau, so the ceiling it applies when a model states no
 * limit for a type is its own constant. This holds it equal to the Bureau's, and holds one
 * upload chunk inside the host's request body limit.
 */
import { DEFAULT_ASSET_POLICY } from '@lostgradient/bureau';
import { describe, expect, test } from 'bun:test';

import { UPLOAD_CHUNK_BYTES } from '../lib/bureau-assets.ts';
import { DEFAULT_MAX_ATTACHMENT_BYTES } from '../lib/chat-attachments.ts';

describe('the attachment limits the page applies', () => {
  test('the ceiling without a stated limit is the Bureau’s default asset ceiling', () => {
    expect(DEFAULT_MAX_ATTACHMENT_BYTES).toBe(DEFAULT_ASSET_POLICY.maxAssetBytes);
  });

  test('a chunk, grown by base64, fits inside the default 1 MiB JSON request body', () => {
    const base64Characters = Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4;
    expect(base64Characters).toBeLessThan(1024 * 1024);
  });
});
