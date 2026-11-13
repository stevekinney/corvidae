import { describe, expect, test } from 'claude-code/testing';

import { protectedReason, riskOf } from '../hooks/policy';

describe('policy', () => {
  test('protects environment files and git internals, not their examples', () => {
    expect(protectedReason('/work/.env', undefined)).toContain('environment secrets');
    expect(protectedReason('/work/.env.production', undefined)).toContain('environment secrets');
    expect(protectedReason('/work/.env.example', undefined)).toBeUndefined();
    expect(protectedReason('/work/.git/config', undefined)).toContain('git itself');
    expect(protectedReason('/work/src/index.ts', undefined)).toBeUndefined();
  });

  test('judges the resolved path as well as the spelling', () => {
    expect(protectedReason('/work/settings.txt', '/work/.env')).toContain('environment secrets');
  });

  test('labels risky shell commands', () => {
    expect(riskOf('rm -rf build')).toBe('recursive delete');
    expect(riskOf('git push -f origin main')).toBe('force push');
    expect(riskOf('git status')).toBeUndefined();
  });
});

describe('register', () => {
  test('a write to a protected file is refused and never reaches the tool', async ($, on) => {
    const ran: string[] = [];
    on('fs.exists', () => ({ value: false }));
    on('ui.log', () => ({ value: undefined }));
    on('tool.call', ($, e) => {
      ran.push(e.tool);
      return { result: 'written' };
    });

    const result = await $.tool.call({
      tool: 'Write',
      file_path: '/work/.env',
      content: 'TOKEN=1',
    });

    expect(result.deny).toContain('was not changed because .env holds environment secrets');
    expect(ran).toEqual([]);
  });

  test('a link that lands on a protected file is refused', async ($, on) => {
    on('fs.exists', () => ({ value: true }));
    on('fs.stat', () => ({
      value: { kind: 'file', size: 9, mtimeMs: 0, isLink: true, realPath: '/work/.env' },
    }));
    on('ui.log', () => ({ value: undefined }));
    on('tool.call', () => ({ result: 'edited' }));

    const result = await $.tool.call({
      tool: 'Edit',
      file_path: '/work/settings.txt',
      old_string: 'a',
      new_string: 'b',
    });

    expect(result.deny).toContain('environment secrets');
  });

  test('the guard fails closed when its own check fails', async ($, on) => {
    const ran: string[] = [];
    on('fs.exists', () => ({ value: true }));
    // A stub that answers { deny } makes the mod's $.fs.stat call reject,
    // so the guard throws before `next` and its `.catch` answers instead.
    on('fs.stat', () => ({ deny: 'the file system refused the read' }));
    on('ui.log', () => ({ value: undefined }));
    on('tool.call', ($, e) => {
      ran.push(e.tool);
      return { result: 'edited' };
    });

    const result = await $.tool.call({
      tool: 'Edit',
      file_path: '/work/src/index.ts',
      old_string: 'a',
      new_string: 'b',
    });

    expect(result.deny).toContain('the protected-path check failed (throw)');
    expect(ran).toEqual([]);
  });

  test('an ordinary edit runs and its result is returned unchanged', async ($, on) => {
    on('fs.exists', () => ({ value: true }));
    on('fs.stat', () => ({
      value: { kind: 'file', size: 9, mtimeMs: 0, isLink: false, realPath: '/work/src/index.ts' },
    }));
    on('ui.log', () => ({ value: undefined }));
    on('tool.call', () => ({ result: 'edited' }));

    const result = await $.tool.call({
      tool: 'Edit',
      file_path: '/work/src/index.ts',
      old_string: 'a',
      new_string: 'b',
    });

    expect(result).toEqual({ result: 'edited' });
  });

  test('a risky command runs only after the person confirms it', async ($, on) => {
    const ran: string[] = [];
    on('ui.log', () => ({ value: undefined }));
    on('tool.call', ($, e) => {
      // $.ui.ask reaches the engine as a call to the AskUserQuestion tool.
      if (e.tool === 'AskUserQuestion') {
        const question = e.questions[0]?.question ?? '';
        return { result: { questions: e.questions, answers: { [question]: 'Run it' } } };
      }
      ran.push(e.tool);
      return { result: 'removed' };
    });

    const result = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' });

    expect(result).toEqual({ result: 'removed' });
    expect(ran).toEqual(['Bash']);
  });

  test('a risky command is refused when nobody can answer', async ($, on) => {
    const ran: string[] = [];
    on('ui.log', () => ({ value: undefined }));
    on('tool.call', ($, e) => {
      if (e.tool === 'AskUserQuestion') return { deny: 'nobody is here to answer' };
      ran.push(e.tool);
      return { result: 'removed' };
    });

    const result = await $.tool.call({ tool: 'Bash', command: 'git reset --hard HEAD~3' });

    expect(result.deny).toContain('did not confirm this hard reset');
    expect(ran).toEqual([]);
  });

  test('the audit observer records outcomes without changing them', async ($, on) => {
    const logged: string[] = [];
    on('ui.log', ($, e) => {
      logged.push(e.text);
      return { value: undefined };
    });
    on('tool.call', () => ({ isError: true, result: 'no such file' }));

    const result = await $.tool.call({ tool: 'Read', file_path: '/work/missing.md' });

    expect(result).toMatchObject({ isError: true, result: 'no such file' });
    expect(logged).toEqual(['audit Read: failed']);
  });
});
