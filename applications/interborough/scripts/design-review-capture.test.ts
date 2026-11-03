/**
 * The design-review capture's command line (`scripts/design-review-capture.ts`): the defaults that
 * a sweep relies on, the narrowing a sign-off uses, and the refusals that keep a typo from
 * silently capturing the wrong thing.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type CaptureEnvironment,
  captureCount,
  captureDesignReview,
  hostEnvironment,
  parseArguments,
  portIsFree,
  probeSocketHandlers,
} from './design-review-capture.ts';
import { endToEndPort } from './environment-configuration.ts';

const NOW = new Date('2026-11-02T08:30:00.000Z');

describe('parseArguments', () => {
  test('captures all three specifications in both schemes into a time-stamped directory by default', () => {
    const options = parseArguments([], NOW);
    if (typeof options === 'string') throw new Error(options);
    expect(options.schemes).toEqual(['light', 'dark']);
    expect(options.specifications).toEqual([
      'tests/e2e/showcase.spec.ts',
      'tests/e2e/responsive.spec.ts',
      'tests/e2e/15-view-states.spec.ts',
    ]);
    expect(options.grep).toBeUndefined();
    expect(options.out).toEndWith('/tmp/design-review/2026-11-02T08-30-00-000Z');
  });

  test('narrows to one scheme, one specification and a title filter for a sign-off', () => {
    const options = parseArguments(
      ['--scheme', 'dark', '--specs', 'states', '--grep', 'schedules is', '--out', 'here'],
      NOW,
    );
    if (typeof options === 'string') throw new Error(options);
    expect(options.schemes).toEqual(['dark']);
    expect(options.specifications).toEqual(['tests/e2e/15-view-states.spec.ts']);
    expect(options.grep).toBe('schedules is');
    expect(options.out).toEndWith('/here');
  });

  test('chooses the content with --data: showcase alone, the stress seed alone, or both', () => {
    const specificationsOf = (argv: string[]) => {
      const options = parseArguments(argv, NOW);
      if (typeof options === 'string') throw new Error(options);
      return options.specifications;
    };
    expect(specificationsOf(['--data', 'showcase'])).toEqual(['tests/e2e/showcase.spec.ts']);
    expect(specificationsOf(['--data', 'stress'])).toEqual([
      'tests/e2e/responsive.spec.ts',
      'tests/e2e/15-view-states.spec.ts',
    ]);
    expect(specificationsOf(['--data', 'both'])).toEqual(specificationsOf([]));
    expect(specificationsOf(['--data', 'stress', '--specs', 'states'])).toEqual([
      'tests/e2e/15-view-states.spec.ts',
    ]);
    expect(specificationsOf(['--specs', 'responsive', '--data', 'both'])).toEqual([
      'tests/e2e/showcase.spec.ts',
      'tests/e2e/responsive.spec.ts',
    ]);
    // `--specs` alone keeps meaning what it always meant: one of the stress specifications.
    expect(specificationsOf(['--specs', 'responsive'])).toEqual(['tests/e2e/responsive.spec.ts']);
  });

  test('refuses an unknown --data, and --specs with showcase data, which it would silently ignore', () => {
    expect(parseArguments(['--data', 'realistic'], NOW)).toBe(
      '--data must be showcase, stress or both, not "realistic"',
    );
    expect(parseArguments(['--data'], NOW)).toBe('--data needs a value');
    expect(parseArguments(['--data', 'showcase', '--specs', 'states'], NOW)).toContain(
      'cannot be used with --data showcase',
    );
    expect(parseArguments(['--specs', 'states', '--data', 'showcase'], NOW)).toContain(
      'cannot be used with --data showcase',
    );
  });

  test('refuses an unknown scheme, an unknown specification, an unknown flag and a missing value', () => {
    expect(parseArguments(['--scheme', 'purple'], NOW)).toContain('--scheme must be');
    expect(parseArguments(['--specs', 'everything'], NOW)).toContain('--specs must be');
    expect(parseArguments(['--color', 'dark'], NOW)).toBe('unknown flag --color');
    expect(parseArguments(['--grep'], NOW)).toBe('--grep needs a value');
    expect(parseArguments(['--out', '--scheme', 'dark'], NOW)).toBe('--out needs a value');
  });
});

describe('portIsFree', () => {
  test('answers false for a port something already listens on, and true once it is released', () => {
    const holder = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const port = holder.port;
    try {
      expect(portIsFree(port)).toBe(false);
    } finally {
      holder.stop(true);
    }
    expect(portIsFree(port)).toBe(true);
  });
});

describe('probeSocketHandlers', () => {
  test('ignores the data a client sends to the port the probe holds', () => {
    expect(probeSocketHandlers.data()).toBeUndefined();
  });
});

describe('captureCount', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'design-review-count-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test('counts the manifest lines that are not blank, and is zero without a manifest', async () => {
    expect(await captureCount(directory)).toBe(0);
    await writeFile(join(directory, 'manifest.jsonl'), '{"a":1}\n\n  \n{"a":2}\n');
    expect(await captureCount(directory)).toBe(2);
  });
});

describe('captureDesignReview', () => {
  let directory = '';
  let saved: string | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'design-review-capture-'));
    saved = process.env['INTERBOROUGH_E2E_PORT'];
    delete process.env['INTERBOROUGH_E2E_PORT'];
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env['INTERBOROUGH_E2E_PORT'];
    else process.env['INTERBOROUGH_E2E_PORT'] = saved;
    await rm(directory, { recursive: true, force: true });
  });

  interface Calls {
    out: string;
    err: string;
    probed: number[];
    commands: { command: readonly string[]; variables: Record<string, string> }[];
  }

  /** A host whose Playwright runs write `manifestLines` captures and exit with the given codes. */
  function standIn(options: { free?: boolean; exitCodes?: number[]; manifestLines?: number }): {
    calls: Calls;
    environment: CaptureEnvironment;
  } {
    const calls: Calls = { out: '', err: '', probed: [], commands: [] };
    const exitCodes = [...(options.exitCodes ?? [])];
    const environment: CaptureEnvironment = {
      standardOutput: (text) => {
        calls.out += text;
      },
      standardError: (text) => {
        calls.err += text;
      },
      portIsFree: (port) => {
        calls.probed.push(port);
        return options.free ?? true;
      },
      async run(command, variables) {
        calls.commands.push({ command, variables });
        const lines = Array.from({ length: options.manifestLines ?? 0 }, () => '{}').join('\n');
        await writeFile(
          join(variables['INTERBOROUGH_DESIGN_REVIEW_CAPTURE'] ?? '', 'manifest.jsonl'),
          lines,
        );
        return exitCodes.shift() ?? 0;
      },
    };
    return { calls, environment };
  }

  test('answers 2 for a bad command line without probing the port', async () => {
    const { calls, environment } = standIn({});
    expect(await captureDesignReview(['--scheme', 'purple'], environment)).toBe(2);
    expect(calls.err).toContain('--scheme must be');
    expect(calls.probed).toEqual([]);
  });

  test('answers 2 and names the variable to set when the end-to-end port is taken', async () => {
    process.env['INTERBOROUGH_E2E_PORT'] = '7721';
    const { calls, environment } = standIn({ free: false });
    expect(await captureDesignReview(['--out', directory], environment)).toBe(2);
    expect(calls.probed).toEqual([7721]);
    expect(calls.err).toContain('port 7721 is already in use');
    expect(calls.err).toContain('INTERBOROUGH_E2E_PORT');
    expect(calls.commands).toEqual([]);
  });

  test('runs Playwright once per scheme with the capture variables and writes a clean summary', async () => {
    const { calls, environment } = standIn({ manifestLines: 3 });
    const out = join(directory, 'nested', 'capture');
    expect(
      await captureDesignReview(
        ['--out', out, '--specs', 'states', '--grep', 'agents'],
        environment,
      ),
    ).toBe(0);
    expect(calls.probed).toEqual([endToEndPort()]);
    expect(calls.commands.map((call) => call.variables)).toEqual([
      { INTERBOROUGH_DESIGN_REVIEW_CAPTURE: out, INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME: 'light' },
      { INTERBOROUGH_DESIGN_REVIEW_CAPTURE: out, INTERBOROUGH_DESIGN_REVIEW_COLOR_SCHEME: 'dark' },
    ]);
    expect(calls.commands[0]?.command).toEqual([
      'bun',
      '--bun',
      'playwright',
      'test',
      '--config',
      'playwright.config.ts',
      'tests/e2e/15-view-states.spec.ts',
      '--grep',
      'agents',
    ]);
    expect(calls.out).toContain('design review: capturing in light: bun --bun playwright test');
    expect(calls.out).toContain(`design review: 3 captures in ${out}\n`);
    const summary = JSON.parse(await readFile(join(out, 'summary.json'), 'utf8'));
    expect(summary).toEqual({
      out,
      captures: 3,
      specifications: ['tests/e2e/15-view-states.spec.ts'],
      grep: 'agents',
      runs: [
        { scheme: 'light', exitCode: 0 },
        { scheme: 'dark', exitCode: 0 },
      ],
      clean: true,
    });
  });

  test('keeps the captures of a run whose specification failed, and says so', async () => {
    const { calls, environment } = standIn({ exitCodes: [0, 1], manifestLines: 2 });
    expect(await captureDesignReview(['--out', directory, '--data', 'showcase'], environment)).toBe(
      0,
    );
    expect(calls.commands[0]?.command).not.toContain('--grep');
    expect(calls.out).toContain('(a specification failed; see summary.json)');
    const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
    expect(summary.clean).toBe(false);
    expect(summary.grep).toBeNull();
  });

  test('answers 1 when nothing was captured', async () => {
    const { environment } = standIn({ manifestLines: 0 });
    expect(await captureDesignReview(['--out', directory, '--scheme', 'dark'], environment)).toBe(
      1,
    );
  });
});

describe('hostEnvironment', () => {
  test('probes the loopback port and runs a command with the variables added to the environment', async () => {
    const holder = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    try {
      expect(hostEnvironment.portIsFree(holder.port)).toBe(false);
    } finally {
      holder.stop(true);
    }
    const directory = await mkdtemp(join(tmpdir(), 'design-review-host-'));
    try {
      const marker = join(directory, 'marker.txt');
      const exitCode = await hostEnvironment.run(
        [
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.env.DESIGN_REVIEW_PROBE ?? '')`,
        ],
        { DESIGN_REVIEW_PROBE: 'seen' },
      );
      expect(exitCode).toBe(0);
      expect(await readFile(marker, 'utf8')).toBe('seen');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
