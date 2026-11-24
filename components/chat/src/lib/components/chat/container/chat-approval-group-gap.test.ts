import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dir, 'chat.svelte'), 'utf8');

// The batch's cards sat about 37px apart: the gap (8px), each bubble's block padding (8px above
// and below) and the message's empty actions line (a 24px minimum). Every box between the two
// cards is accounted for here, so the distance is exactly one group gap, `--cinder-space-3`.
describe('batch approval group spacing', () => {
  test('rows stand one group gap apart', () => {
    expect(source).toMatch(/\.chat-approval-group-rows\s*\{[^}]*gap: var\(--cinder-space-3\);/);
  });

  // COR-2282 A3: two or more approvals are Cinder's one bordered group, which draws its own heading
  // and separators; Chat keeps no heading of its own.
  test('a batch is Cinder’s ApprovalGroup, with no heading of Chat’s own', () => {
    expect(source).toContain('<ApprovalGroup');
    expect(source).not.toContain('chat-approval-group-heading');
  });

  test('nothing else stands between two cards', () => {
    expect(source).toMatch(
      /\.chat-approval-group-rows :global\(\.chat-message-wrapper\.chat-message-wrapper\)\s*\{\s*margin-block-end: 0;/,
    );
    expect(source).toMatch(
      /\.chat-approval-group-rows :global\(\.chat-message-wrapper \.chat-message\)\s*\{\s*padding-block: 0;/,
    );
    expect(source).toMatch(
      /\.chat-approval-group-rows :global\(\.chat-message-wrapper \.chat-message-line\),\s*\.chat-approval-group-rows :global\(\.chat-message-wrapper \.chat-message-notes\)\s*\{\s*display: none;/,
    );
  });

  test('reserves the coarse-pointer boundary before an adjacent Message details control', () => {
    expect(source).toMatch(
      /@media \(any-pointer: coarse\)\s*\{\s*\.chat-tool-call-group > \.chat-approval-group-rows:empty \+ :global\(\.chat-message-wrapper\)\s*\{\s*margin-block-start: var\(--cinder-space-1\);/s,
    );
  });
});
