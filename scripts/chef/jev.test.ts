import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildQuestion,
  defaultThreshold,
  interpretAnswer,
  JEV_ENDPOINT,
  parseChoices,
  parseScale,
  parseThreshold,
  retryDelaySeconds,
  run,
  sha256,
  type FetchLike,
  type JevDependencies,
} from './jev.ts';
import { UsageError } from './process-runner.ts';

const SECRET = 'ts-test-key-0123456789-not-a-real-credential';
const STATE = 'Candidate fails 3 of 5; base fails 2 of 5. Private detail: customer-4711.';

let sandbox: string;
let recordPath: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'jev-'));
  recordPath = join(sandbox, 'tmp', 'chef', 'jev.jsonl');
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

interface Sent {
  url: string;
  authorization: string;
  body: { state: string; model: string; questions: Record<string, unknown> };
}

function wireResponse(answer: unknown, model = 'jev-1.14.0'): Response {
  return Response.json({
    model,
    answers: { decision: answer },
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

function server(responses: (Response | Error)[]) {
  const sent: Sent[] = [];
  const sleeps: number[] = [];
  let next = 0;
  const fetchLike: FetchLike = async (url, init) => {
    sent.push({
      url,
      authorization: String((init.headers as Record<string, string>).Authorization),
      body: JSON.parse(init.body as string),
    });
    const response = responses[Math.min(next, responses.length - 1)];
    next += 1;
    if (response instanceof Error) throw response;
    return response?.clone() ?? new Response('', { status: 500 });
  };
  const dependencies: Partial<JevDependencies> = {
    fetch: fetchLike,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    now: () => new Date('2026-10-22T12:00:00Z'),
    resolveKey: () => SECRET,
    mainCheckout: () => sandbox,
  };
  return { sent, sleeps, dependencies };
}

const yesNo = ['decide', '--question', 'Is this shared?', '--state', STATE, '--yes-no'];

function records(): Record<string, unknown>[] {
  return readFileSync(recordPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('wire format', () => {
  test('builds the three question types as the TypeSafe adapter sends them', () => {
    expect(buildQuestion('q', { type: 'yes-no' })).toEqual({ type: 'noul', instructions: 'q' });
    expect(buildQuestion('q', { type: 'choice', options: { a: 'An a', b: null } })).toEqual({
      type: 'choice',
      instructions: 'q',
      criteria: { a: 'An a', b: null },
    });
    expect(buildQuestion('q', { type: 'scale', levels: ['low', 'high'] })).toEqual({
      type: 'score',
      instructions: 'q',
      criteria: ['low', 'high'],
    });
  });

  test('a yes/no answer is the likelier side with that side probability', () => {
    expect(interpretAnswer({ type: 'yes-no' }, { type: 'noul', noul: 0.95 })).toEqual({
      answer: 'yes',
      probability: 0.95,
      probabilities: { yes: 0.95, no: expect.closeTo(0.05, 5) },
    });
    const no = interpretAnswer({ type: 'yes-no' }, { type: 'noul', noul: 0.04 });
    expect(no).toMatchObject({ answer: 'no', probability: expect.closeTo(0.96, 5) });
  });

  test('a choice answer uses the chosen option probability and rejects an option never offered', () => {
    const mode = { type: 'choice' as const, options: { flat: 'Flat', builder: 'Builder' } };
    expect(
      interpretAnswer(mode, {
        type: 'choice',
        choice: 'flat',
        confidence: 0.9,
        probabilities: { flat: 0.93, builder: 0.07 },
      }),
    ).toEqual({ answer: 'flat', probability: 0.93, probabilities: { flat: 0.93, builder: 0.07 } });
    expect(
      typeof interpretAnswer(mode, {
        type: 'choice',
        choice: 'other',
        probabilities: { flat: 1, builder: 0 },
      }),
    ).toBe('string');
    expect(
      typeof interpretAnswer(mode, { type: 'choice', choice: 'flat', probabilities: { flat: 1 } }),
    ).toBe('string');
  });

  test('a scale answer is the level nearest the score, clamped, with that level probability', () => {
    const mode = { type: 'scale' as const, levels: ['none', 'light', 'full'] };
    const wire = (score: number) => ({
      type: 'score',
      score,
      confidence: 0.9,
      legend: { '0': 'none', '1': 'light', '2': 'full' },
      probabilities: { '0': 0.01, '1': 0.2, '2': 0.79 },
    });
    expect(interpretAnswer(mode, wire(1.97))).toEqual({
      answer: 'full',
      probability: 0.79,
      probabilities: { none: 0.01, light: 0.2, full: 0.79 },
    });
    expect(interpretAnswer(mode, wire(0.4))).toMatchObject({ answer: 'none' });
    expect(interpretAnswer(mode, wire(7))).toMatchObject({ answer: 'full' });
    expect(interpretAnswer(mode, wire(-3))).toMatchObject({ answer: 'none' });
  });

  test('a wrong answer type for the question is unusable', () => {
    expect(typeof interpretAnswer({ type: 'yes-no' }, { type: 'score', score: 1 })).toBe('string');
    expect(typeof interpretAnswer({ type: 'yes-no' }, null)).toBe('string');
    expect(typeof interpretAnswer({ type: 'yes-no' }, { type: 'noul', noul: 2 })).toBe('string');
  });
});

describe('parsing', () => {
  test('--choice keys, descriptions, duplicates and the two-option minimum', () => {
    expect(parseChoices(['a=First: a thing', 'b='])).toEqual({ a: 'First: a thing', b: null });
    expect(() => parseChoices(['a=1'])).toThrow(UsageError);
    expect(() => parseChoices(['a=1', 'a=2'])).toThrow(UsageError);
    expect(() => parseChoices(['=x', 'b=2'])).toThrow(UsageError);
  });

  test('--scale levels', () => {
    expect(parseScale('none, light ,full')).toEqual(['none', 'light', 'full']);
    expect(() => parseScale('one')).toThrow(UsageError);
    expect(() => parseScale('a,,b')).toThrow(UsageError);
    expect(() => parseScale('a,a')).toThrow(UsageError);
  });

  test('thresholds: 0.85 routine, 0.9 owner, and a probability for an override', () => {
    expect(defaultThreshold('routine')).toBe(0.85);
    expect(defaultThreshold('owner')).toBe(0.9);
    expect(parseThreshold('0.5')).toBe(0.5);
    for (const bad of ['0', '1.1', 'x', '', '-1'])
      expect(() => parseThreshold(bad)).toThrow(UsageError);
  });

  test('Retry-After as seconds or a date, clamped, with a default', () => {
    const now = new Date('2026-10-22T12:00:00Z');
    expect(retryDelaySeconds('7', now)).toBe(7);
    expect(retryDelaySeconds('Thu, 22 Oct 2026 12:00:30 GMT', now)).toBe(30);
    expect(retryDelaySeconds(null, now)).toBe(1);
    expect(retryDelaySeconds('soon', now)).toBe(1);
    expect(retryDelaySeconds('99999', now)).toBe(120);
    expect(retryDelaySeconds('-5', now)).toBe(0);
  });
});

describe('decide', () => {
  test('a yes at the routine threshold exits 0, sends the documented request, and records it', async () => {
    const { sent, dependencies } = server([wireResponse({ type: 'noul', noul: 0.9 })]);
    const result = await run([...yesNo, '--record', recordPath], dependencies);
    expect(result.code).toBe(0);
    expect(result.output).toContain('DECIDED: yes (p=0.90) model=jev-1.14.0 threshold=0.85');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      url: JEV_ENDPOINT,
      authorization: `Bearer ${SECRET}`,
      body: {
        state: STATE,
        model: 'jev-latest',
        questions: { decision: { type: 'noul', instructions: 'Is this shared?' } },
      },
    });
    const [entry] = records();
    expect(entry).toEqual({
      timestamp: '2026-10-22T12:00:00.000Z',
      kind: 'routine',
      question: 'Is this shared?',
      options: ['yes', 'no'],
      answer: 'yes',
      probability: 0.9,
      model: 'jev-1.14.0',
      threshold: 0.85,
      outcome: 'decided',
      reason: null,
      stateSha256: sha256(STATE),
    });
  });

  test('the same probability clears a routine call and misses an owner decision', async () => {
    const answer = () => wireResponse({ type: 'noul', noul: 0.87 });
    const routine = await run(yesNo, { ...server([answer()]).dependencies });
    expect(routine.code).toBe(0);
    const owner = await run([...yesNo, '--kind', 'owner'], { ...server([answer()]).dependencies });
    expect(owner.code).toBe(1);
    expect(owner.output).toContain('BELOW THRESHOLD');
    expect(owner.output).toContain('threshold=0.90 kind=owner');
    const override = await run([...yesNo, '--kind', 'owner', '--threshold', '0.8'], {
      ...server([answer()]).dependencies,
    });
    expect(override.code).toBe(0);
  });

  test('a confident no is a decision too', async () => {
    const result = await run(
      yesNo,
      server([wireResponse({ type: 'noul', noul: 0.02 })]).dependencies,
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain('DECIDED: no (p=0.98)');
  });

  test('a choice sends its options and reports every probability', async () => {
    const { sent, dependencies } = server([
      wireResponse({
        type: 'choice',
        choice: 'builder',
        confidence: 0.6,
        probabilities: { flat: 0.4, builder: 0.6 },
      }),
    ]);
    const result = await run(
      [
        'decide',
        '--kind',
        'owner',
        '--question',
        'Which shape?',
        '--state',
        STATE,
        '--choice',
        'flat=One function',
        '--choice',
        'builder=A chainable builder',
        '--json',
        '--record',
        recordPath,
      ],
      dependencies,
    );
    expect(result.code).toBe(1);
    const json = JSON.parse(result.output);
    expect(json).toMatchObject({
      outcome: 'below-threshold',
      cleared: false,
      answer: 'builder',
      probability: 0.6,
      probabilities: { flat: 0.4, builder: 0.6 },
      threshold: 0.9,
    });
    expect(sent[0]?.body.questions).toEqual({
      decision: {
        type: 'choice',
        instructions: 'Which shape?',
        criteria: { flat: 'One function', builder: 'A chainable builder' },
      },
    });
  });

  test('a scale reports the level, and --state-file supplies the state', async () => {
    const stateFile = join(sandbox, 'state.txt');
    writeFileSync(stateFile, 'from a file');
    const { sent, dependencies } = server([
      wireResponse({
        type: 'score',
        score: 0.1,
        confidence: 0.95,
        legend: { '0': 'none', '1': 'light', '2': 'full' },
        probabilities: { '0': 0.97, '1': 0.02, '2': 0.01 },
      }),
    ]);
    const result = await run(
      [
        'decide',
        '--question',
        'How much?',
        '--state-file',
        stateFile,
        '--scale',
        'none,light,full',
        '--record',
        recordPath,
      ],
      dependencies,
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain('DECIDED: none (p=0.97)');
    expect(sent[0]?.body.state).toBe('from a file');
    expect(sent[0]?.body.questions.decision).toEqual({
      type: 'score',
      instructions: 'How much?',
      criteria: ['none', 'light', 'full'],
    });
  });
});

describe('unavailable', () => {
  const cases: [string, (Response | Error)[], string][] = [
    ['a 401', [new Response('nope', { status: 401 })], 'HTTP 401'],
    ['a 500', [new Response('', { status: 500 })], 'HTTP 500'],
    ['a 529', [new Response('', { status: 529 })], 'HTTP 529'],
    ['a network error', [new TypeError('fetch failed')], 'network error (TypeError)'],
    ['a response that is not JSON', [new Response('<html>', { status: 200 })], 'not JSON'],
    ['an unexpected shape', [Response.json({ hello: 1 })], 'unexpected shape'],
    ['a refused question', [Response.json({ model: 'm', answers: {} })], 'declined'],
    ['the wrong answer type', [wireResponse({ type: 'score', score: 1 })], 'no probability'],
  ];
  for (const [name, responses, reason] of cases) {
    test(`${name} exits 3 with the reason and records it`, async () => {
      const { dependencies, sleeps } = server(responses);
      const result = await run([...yesNo, '--record', recordPath], dependencies);
      expect(result.code).toBe(3);
      expect(result.output).toContain('Jev unavailable');
      expect(result.output).toContain(reason);
      expect(sleeps).toEqual([]);
      expect(records()[0]).toMatchObject({ outcome: 'unavailable', answer: null });
    });
  }

  test('no credential exits 3 without a request', async () => {
    const { dependencies, sent } = server([wireResponse({ type: 'noul', noul: 1 })]);
    const result = await run([...yesNo, '--record', recordPath], {
      ...dependencies,
      resolveKey: () => undefined,
    });
    expect(result.code).toBe(3);
    expect(result.output).toContain('TYPESAFE_API_KEY');
    expect(sent).toEqual([]);
  });

  test('a 429 waits the time asked, retries once, and then decides', async () => {
    const limited = new Response('', { status: 429, headers: { 'retry-after': '4' } });
    const { dependencies, sent, sleeps } = server([
      limited,
      wireResponse({ type: 'noul', noul: 0.99 }),
    ]);
    const result = await run(yesNo, dependencies);
    expect(result.code).toBe(0);
    expect(sleeps).toEqual([4000]);
    expect(sent).toHaveLength(2);
  });

  test('a second 429 exits 3 after exactly one wait and one retry', async () => {
    const limited = new Response('', { status: 429, headers: { 'retry-after': '2' } });
    const { dependencies, sent, sleeps } = server([limited]);
    const result = await run(yesNo, dependencies);
    expect(result.code).toBe(3);
    expect(result.output).toContain('HTTP 429 after one retry');
    expect(sleeps).toEqual([2000]);
    expect(sent).toHaveLength(2);
  });
});

describe('secrets and records', () => {
  test('the key appears in no output, error, or record, and the state is hashed not stored', async () => {
    const outputs: string[] = [];
    for (const responses of [
      [wireResponse({ type: 'noul', noul: 0.99 })],
      [new Response(`echo ${SECRET}`, { status: 401 })],
      [new Error(`boom ${SECRET}`)],
    ]) {
      const { dependencies } = server(responses);
      for (const flag of [[], ['--json']]) {
        const result = await run([...yesNo, ...flag, '--record', recordPath], dependencies);
        outputs.push(result.output);
      }
    }
    for (const output of outputs) expect(output).not.toContain(SECRET);
    const text = readFileSync(recordPath, 'utf8');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('customer-4711');
    expect(text).toContain(sha256(STATE));
    expect(text.trim().split('\n')).toHaveLength(6);
  });

  test('the default record is <main checkout>/tmp/chef/jev-decisions.jsonl', async () => {
    const { dependencies } = server([wireResponse({ type: 'noul', noul: 0.99 })]);
    await run(yesNo, dependencies);
    const path = join(sandbox, 'tmp', 'chef', 'jev-decisions.jsonl');
    expect(readFileSync(path, 'utf8')).toContain('"outcome":"decided"');
  });

  test('a record that cannot be written is a visible warning, not a lost decision', async () => {
    const { dependencies } = server([wireResponse({ type: 'noul', noul: 0.99 })]);
    const blocker = join(sandbox, 'file');
    writeFileSync(blocker, 'x');
    const result = await run(
      [...yesNo, '--record', join(blocker, 'nested', 'r.jsonl')],
      dependencies,
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain('WARNING: the decision was not recorded');
  });
});

describe('usage', () => {
  test('rejects missing or conflicting arguments before any request', async () => {
    const { dependencies, sent } = server([wireResponse({ type: 'noul', noul: 1 })]);
    const base = ['decide', '--question', 'Q?', '--state', 's'];
    const attempts: string[][] = [
      [],
      ['bogus'],
      ['decide', '--state', 's', '--yes-no'],
      ['decide', '--question', 'Q?', '--yes-no'],
      [...base],
      [...base, '--yes-no', '--scale', 'a,b'],
      [...base, '--yes-no', '--choice', 'a=1', '--choice', 'b=2'],
      [...base, '--yes-no', '--kind', 'boss'],
      [...base, '--yes-no', '--threshold', '2'],
      [...base, '--choice', 'a=1'],
      [...base, '--scale', 'a'],
      ['decide', '--question', 'Q?', '--state', 's', '--state-file', 'f', '--yes-no'],
      ['decide', '--question', 'Q?', '--state-file', join(sandbox, 'missing'), '--yes-no'],
      ['decide', '--question', 'Q?', '--state', '  ', '--yes-no'],
      [...base, '--yes-no', 'extra'],
    ];
    for (const attempt of attempts) {
      const error = await run(attempt, dependencies).catch((reason: unknown) => reason);
      expect(error, attempt.join(' ')).toBeInstanceOf(UsageError);
    }
    expect(sent).toEqual([]);
  });
});
