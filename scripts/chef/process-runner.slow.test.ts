import { expect } from 'bun:test';
import { defaultRunner, shellQuote } from './process-runner.ts';
import { createScenarios } from './scenario.test-support.ts';

/** `defaultRunner` starts real processes, so each case runs at module scope in the slow lane. */
const scenarios = createScenarios();

scenarios.scenario('defaultRunner captures stdout, stderr and the exit code', () => {
  const result = defaultRunner(['sh', '-c', 'echo out; echo err >&2; exit 3']);
  expect(result).toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n' });
});

scenarios.scenario('defaultRunner passes input on standard input', () => {
  expect(defaultRunner(['cat'], { input: 'hello' }).stdout).toBe('hello');
});

scenarios.scenario('defaultRunner runs in the requested working directory', () => {
  expect(defaultRunner(['pwd'], { cwd: '/' }).stdout.trim()).toBe('/');
});

scenarios.scenario('defaultRunner merges env over the inherited environment', () => {
  const result = defaultRunner(['sh', '-c', 'echo "$CHEF_PLUMBING_TEST:$HOME"'], {
    env: { CHEF_PLUMBING_TEST: 'yes' },
  });
  expect(result.stdout.trim().startsWith('yes:/')).toBe(true);
});

scenarios.scenario('defaultRunner reports a program that cannot start as exit 127', () => {
  const result = defaultRunner(['chef-plumbing-no-such-program']);
  expect(result.code).toBe(127);
  expect(result.stderr).not.toBe('');
});

scenarios.scenario('defaultRunner reports a missing working directory as exit 127', () => {
  expect(defaultRunner(['true'], { cwd: '/chef-plumbing/missing' }).code).toBe(127);
});

scenarios.scenario('shellQuote round-trips awkward text through a shell', () => {
  const text = `it's "quoted" $HOME \`x\` ; & *`;
  expect(defaultRunner(['sh', '-c', `printf %s ${shellQuote(text)}`]).stdout).toBe(text);
});

scenarios.scenario(
  'defaultRunner reports a spawn that throws without quoting the environment value',
  () => {
    // Bun rejects a NUL byte in an environment value and quotes the value in the error it throws.
    const SECRET = 'FAKE-credential-0123456789';
    const result = defaultRunner(['true'], { env: { CHEF_PLUMBING_TEST: `${SECRET}\u0000` } });
    expect(result.code).toBe(127);
    expect(result.stderr).toContain('could not start the command');
    expect(result.stderr).not.toContain(SECRET);
    expect(result.stdout).not.toContain(SECRET);
  },
);

scenarios.scenario(
  'defaultRunner reports a process killed by a signal as 128 plus the signal',
  () => {
    const result = defaultRunner(['sh', '-c', 'kill -TERM $$']);
    expect(result.code).toBe(143);
    expect(result.stderr).toContain('terminated by signal SIGTERM');
  },
);

await scenarios.settled();
