import { describe, expect, test } from 'bun:test';

import { channelsForMode, validateCapabilities } from './capabilities.ts';
import {
  OUTPUT_ONLY_CAPABILITIES,
  PIPE_CAPABILITIES,
  PTY_CAPABILITIES,
  READ_ONLY_CAPABILITIES,
} from './endpoint-pair.test-support.ts';

describe('validateCapabilities', () => {
  test.each([
    ['a writable PTY', PTY_CAPABILITIES],
    ['a read-only PTY', READ_ONLY_CAPABILITIES],
    ['a pipe', PIPE_CAPABILITIES],
    ['an output-only source', OUTPUT_ONLY_CAPABILITIES],
  ])('accepts %s', (_name, capabilities) => {
    expect(validateCapabilities(capabilities)).toBeUndefined();
  });

  test.each([
    ['an output-only source that accepts input', { ...OUTPUT_ONLY_CAPABILITIES, input: true }],
    ['an output-only source that can resize', { ...OUTPUT_ONLY_CAPABILITIES, resize: true }],
    ['an output-only source that can be killed', { ...OUTPUT_ONLY_CAPABILITIES, kill: true }],
    ['a pipe that can resize', { ...PIPE_CAPABILITIES, resize: true }],
    ['a read-only attachment that accepts input', { ...READ_ONLY_CAPABILITIES, input: true }],
    ['a read-only attachment that can resize', { ...READ_ONLY_CAPABILITIES, resize: true }],
  ])('rejects %s', (_name, capabilities) => {
    expect(validateCapabilities(capabilities)).toBe('invalid-capabilities');
  });

  test('never grants more than the client asked for', () => {
    expect(validateCapabilities(PTY_CAPABILITIES, 'read-only')).toBe('invalid-capabilities');
    expect(validateCapabilities(READ_ONLY_CAPABILITIES, 'read-only')).toBeUndefined();
    expect(validateCapabilities(READ_ONLY_CAPABILITIES, 'interactive')).toBeUndefined();
    expect(validateCapabilities(PTY_CAPABILITIES, 'interactive')).toBeUndefined();
  });
});

describe('channelsForMode', () => {
  test('gives a PTY one stream, a pipe separate stdout and stderr, and a source stdout', () => {
    expect(channelsForMode('pty')).toEqual(['pty']);
    expect(channelsForMode('pipe')).toEqual(['stdout', 'stderr']);
    expect(channelsForMode('output-only')).toEqual(['stdout']);
  });
});
