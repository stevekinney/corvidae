import { describe, expect, test } from 'claude-code/testing';

import { countOutcome, countRequested, describeTally, emptyTally, outcomeOf } from '../hooks/tally';

// What the engine stamps on a command the person typed at a terminal.
const TYPED_AT_TERMINAL = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const;

describe('tally', () => {
  test('classifies results by deny, isError, or neither', () => {
    expect(outcomeOf({ deny: 'no' })).toBe('refused');
    expect(outcomeOf({ isError: true })).toBe('failed');
    expect(outcomeOf({})).toBe('succeeded');
  });

  test('reports calls that have not finished', () => {
    const tally = countOutcome(countRequested(countRequested(emptyTally)), 'succeeded');
    expect(describeTally(tally)).toBe(
      '2 tool calls since this mod loaded: 1 succeeded, 0 failed, 0 refused, 1 still running.',
    );
  });
});

describe('register', () => {
  test('/tool-tally reports each outcome the hooks observed', async ($, on) => {
    // Stubs stand for Claude Code beneath the mod: nothing real runs.
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('command.register', ($, e) => ({ value: { command: e.name } }));
    on('tool.call', ($, e) => {
      if (e.tool === 'Bash') return { deny: 'refused by a rule' };
      if (e.tool === 'Read') return { isError: true, result: 'no such file' };
      return { result: 'ok' };
    });

    await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
    await $.tool.call({ tool: 'Bash', command: 'ls' });
    await $.tool.call({ tool: 'Read', file_path: '/work/missing.md' });
    await $.tool.call({ tool: 'Write', file_path: '/work/notes.md', content: 'hello' });

    const answer = await $.command.run({ command: 'tool-tally', args: '', ...TYPED_AT_TERMINAL });
    expect(answer.text).toBe(
      '3 tool calls since this mod loaded: 1 succeeded, 1 failed, 1 refused.',
    );
  });

  test('a taken command name does not stop the session from starting', async ($, on) => {
    const logged: string[] = [];
    on('session.start', ($, e) => ({ cwd: e.cwd }));
    on('command.register', () => ({ deny: '"/tool-tally" refused: it is taken' }));
    on('ui.log', ($, e) => {
      logged.push(e.text);
      return { value: undefined };
    });

    const started = await $.session.start({
      cwd: '/work',
      surface: 'terminal',
      isInteractive: true,
    });
    expect(started).toEqual({ cwd: '/work' });
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain('/tool-tally was not registered');
  });
});
