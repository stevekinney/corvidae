import { describe, expect, test } from 'bun:test';

import { acceptsInput, isErrorState, mountsEngine, ownsGrid } from './terminal-state.ts';
import {
  TERMINAL_FRAME_STATUS,
  TERMINAL_STATE_MESSAGE,
  type TerminalState,
} from './terminal.types.ts';

const STATES = Object.keys(TERMINAL_FRAME_STATUS) as TerminalState[];

describe('state policy', () => {
  test('covers exactly the twelve specified states', () => {
    const specified: TerminalState[] = [
      'backpressured',
      'cleanup-incomplete',
      'connecting',
      'denied',
      'disconnected',
      'empty',
      'engine-load-failed',
      'exited',
      'failed',
      'loading',
      'read-only',
      'writable',
    ];
    expect(STATES.toSorted()).toEqual(specified.toSorted());
  });

  test('mounts the engine in every state except empty and engine-load-failed', () => {
    expect(STATES.filter((state) => !mountsEngine(state)).toSorted()).toEqual([
      'empty',
      'engine-load-failed',
    ]);
  });

  test('owns the grid only while loading, connecting, writable, or backpressured', () => {
    expect(STATES.filter(ownsGrid).toSorted()).toEqual([
      'backpressured',
      'connecting',
      'loading',
      'writable',
    ]);
  });

  test('accepts input only when writable', () => {
    expect(STATES.filter(acceptsInput)).toEqual(['writable']);
  });

  test('knows the four error states', () => {
    expect(STATES.filter(isErrorState).toSorted()).toEqual([
      'cleanup-incomplete',
      'denied',
      'engine-load-failed',
      'failed',
    ]);
  });

  test('every error state renders inside the frame error status', () => {
    for (const state of STATES) {
      expect(TERMINAL_FRAME_STATUS[state] === 'error').toBe(isErrorState(state));
    }
  });
});

describe('experience copy', () => {
  test('pins each state message to the literal in documentation/terminal/experience.md', () => {
    expect(TERMINAL_STATE_MESSAGE).toEqual({
      empty: 'No terminal session',
      loading: 'Loading terminal…',
      connecting: 'Connecting…',
      writable: 'Connected',
      'read-only': 'Read-only',
      backpressured: 'Backpressure: input paused',
      exited: 'Process exited',
      disconnected: 'Disconnected',
      denied: 'Access denied',
      failed: 'Terminal failed',
      'cleanup-incomplete': 'Cleanup incomplete—new sessions are disabled',
      'engine-load-failed': 'Terminal engine unavailable',
    });
  });

  test('every message appears in the experience document', async () => {
    const document = await Bun.file(
      new URL('../../../../../../documentation/terminal/experience.md', import.meta.url),
    ).text();
    for (const message of Object.values(TERMINAL_STATE_MESSAGE)) {
      // The document writes "Process exited" with an optional exit code, and the rest verbatim.
      expect(document).toContain(`\`${message}\``);
    }
  });

  test('maps states to the closed TerminalFrame status vocabulary of the document', () => {
    expect(TERMINAL_FRAME_STATUS).toEqual({
      empty: 'disconnected',
      loading: 'connecting',
      connecting: 'connecting',
      writable: 'connected',
      'read-only': 'connected',
      backpressured: 'connected',
      exited: 'disconnected',
      disconnected: 'disconnected',
      denied: 'error',
      failed: 'error',
      'cleanup-incomplete': 'error',
      'engine-load-failed': 'error',
    });
  });
});
