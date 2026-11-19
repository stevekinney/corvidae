import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { runWithHangGuard } from '../testing/testing/src/hang-guard.ts';

const missing = await runWithHangGuard(['bun', join(import.meta.dir, 'check-prose-questions.ts')], {
  stdin: Buffer.from(JSON.stringify({ transcript_path: '/nonexistent/transcript.jsonl' })),
});

describe('check-prose-questions as a process', () => {
  test('fails open on a missing transcript: exit 0, no block, a message on stderr', () => {
    expect(missing.exitCode).toBe(0);
    expect(missing.stdout.toString()).toBe('');
    expect(missing.stderr.toString()).toContain('allowing the stop');
  });
});
