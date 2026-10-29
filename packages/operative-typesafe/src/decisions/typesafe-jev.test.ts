import { DecisionProviderUnavailableError, type DecisionRequest } from '@lostgradient/operative';
import {
  decisionScenarios,
  runDecisionModelContract,
  type DecisionContractCase,
} from '@lostgradient/operative/decision-testing';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { createTypesafeJev, importTypesafePeers, typesafeJev } from './typesafe-jev';

const structuredRequest: DecisionRequest = {
  kind: 'structured',
  question: 'Triage this ticket.',
  context: 'Checkout is down.',
  schema: z.object({ team: z.string(), urgent: z.boolean() }),
};

const jevCases: readonly DecisionContractCase[] = decisionScenarios.map((scenario) => ({
  name: scenario.name,
  request: scenario.request,
  expected: scenario.expected,
}));

interface RecordedFixture {
  readonly scenario: string;
  readonly exchange: {
    readonly path: string;
    readonly requestBody: unknown;
    readonly status: number;
    readonly responseBody: unknown;
  };
}

const FIXTURE_DIRECTORY = join(import.meta.dir, '..', '..', 'test', 'fixtures', 'decisions');
const REPLAY_KEY = 'replay-key-not-a-secret';

function loadFixtures(): readonly RecordedFixture[] {
  return readdirSync(FIXTURE_DIRECTORY)
    .filter((file) => file.endsWith('.json'))
    .map(
      (file) => JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, file), 'utf8')) as RecordedFixture,
    );
}

describe('typesafeJev contract over recorded fixtures', () => {
  const fixtures = loadFixtures();
  const realFetch = globalThis.fetch;
  const used = new Set<string>();
  const unmatched: string[] = [];
  const authorizations: (string | null)[] = [];

  /** Serves only recorded responses; a request with no recording fails the suite. */
  const replayFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    authorizations.push(new Headers(init?.headers).get('authorization'));
    const match = fixtures.find(
      (fixture) =>
        fixture.exchange.path === url.pathname &&
        Bun.deepEquals(fixture.exchange.requestBody, body, true),
    );
    if (match === undefined) {
      unmatched.push(`${url.pathname} ${JSON.stringify(body)}`);
      throw new Error(`No recorded fixture for ${url.pathname}`);
    }
    used.add(match.scenario);
    return new Response(JSON.stringify(match.exchange.responseBody), {
      status: match.exchange.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  beforeAll(() => {
    // No test in this suite may reach the network: a request that bypasses the injected
    // `fetch` lands on this trap and fails the run.
    globalThis.fetch = (() => {
      unmatched.push('global fetch called');
      throw new Error('The decision suite must not use the network.');
    }) as unknown as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  describe('contract', () => {
    runDecisionModelContract(
      () => typesafeJev({ apiKey: REPLAY_KEY, fetch: replayFetch }),
      jevCases,
    );
  });

  it('replays every recorded fixture and calls no other endpoint', () => {
    expect([...used].toSorted()).toEqual(fixtures.map((fixture) => fixture.scenario).toSorted());
    expect(unmatched).toEqual([]);
    expect(new Set(authorizations)).toEqual(new Set([`Bearer ${REPLAY_KEY}`]));
  });

  it('holds no credential in any fixture', () => {
    for (const file of readdirSync(FIXTURE_DIRECTORY).filter((name) => name.endsWith('.json'))) {
      const text = readFileSync(join(FIXTURE_DIRECTORY, file), 'utf8');
      expect(text.toLowerCase()).not.toContain('authorization');
      expect(text.toLowerCase()).not.toContain('bearer');
    }
  });

  it('reports the probability of the chosen side, not P(true)', async () => {
    const model = typesafeJev({ apiKey: REPLAY_KEY, fetch: replayFetch });
    const no = decisionScenarios.find((scenario) => scenario.name === 'boolean-false')!;
    const fixture = fixtures.find((candidate) => candidate.scenario === 'boolean-false')!;
    const wire = (fixture.exchange.responseBody as { answers: { decision: { noul: number } } })
      .answers.decision.noul;

    const decision = await model.decide(no.request);

    expect(decision.value).toBe(false);
    expect(decision.probability).toBeCloseTo(1 - wire, 10);
    expect(decision.provider).toBe('typesafe');
    expect(decision.model).toBe((fixture.exchange.responseBody as { model: string }).model);
  });

  it('maps Jev usage onto prompt, completion and total', async () => {
    const model = typesafeJev({ apiKey: REPLAY_KEY, fetch: replayFetch });
    const scale = decisionScenarios.find((scenario) => scenario.name === 'scale')!;
    const fixture = fixtures.find((candidate) => candidate.scenario === 'scale')!;
    const wire = (
      fixture.exchange.responseBody as { usage: { input_tokens: number; output_tokens: number } }
    ).usage;

    const decision = await model.decide(scale.request);

    expect(decision.usage).toEqual({
      prompt: wire.input_tokens,
      completion: wire.output_tokens,
      total: wire.input_tokens + wire.output_tokens,
    });
  });

  it('serves boolean, choice and scale only', async () => {
    const model = typesafeJev({ apiKey: REPLAY_KEY, fetch: replayFetch });
    expect([...model.kinds].toSorted()).toEqual(['boolean', 'choice', 'scale']);

    const failure = await model.decide(structuredRequest).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TypeError);
  });

  it('rejects with the peer error, unretried, when Jev answers an HTTP error', async () => {
    let calls = 0;
    const failing = (async () => {
      calls += 1;
      return new Response('{"error":"unauthorized"}', { status: 401, statusText: 'Unauthorized' });
    }) as unknown as typeof fetch;
    const model = typesafeJev({ apiKey: REPLAY_KEY, fetch: failing });

    const failure = (await model
      .decide(decisionScenarios[0]!.request)
      .catch((error: unknown) => error)) as Error & { status?: number };

    expect(failure.status).toBe(401);
    expect(calls).toBe(1);
  });

  it('judges the answer against the request as it was asked, not as the caller later changed it', async () => {
    const choiceRequest = decisionScenarios.find((scenario) => scenario.name === 'choice')!.request;
    if (choiceRequest.kind !== 'choice') throw new Error('The choice scenario must be a choice.');
    const options = choiceRequest.options.map((option) => ({ ...option }));
    const mutating = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      options.length = 0;
      return replayFetch(input, init);
    }) as typeof fetch;
    const model = typesafeJev({ apiKey: REPLAY_KEY, fetch: mutating });

    const decision = await model.decide({ ...choiceRequest, options });

    expect(decision.value).toBe('billing');
  });

  it('rejects an empty API key at construction, before anything is loaded', () => {
    expect(() => typesafeJev({ apiKey: ' ' })).toThrow(TypeError);
  });

  it('passes the abort signal to the request', async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null | undefined;
    const capturing = (async (_input: unknown, init?: RequestInit) => {
      seen = init?.signal;
      return replayFetch(_input as string, init);
    }) as unknown as typeof fetch;
    const model = typesafeJev({ apiKey: REPLAY_KEY, fetch: capturing });

    await model.decide(decisionScenarios[0]!.request, { signal: controller.signal });

    expect(seen).toBe(controller.signal);
  });

  describe('peer loading', () => {
    const missing = Object.assign(new Error("Cannot find package '@tanstack/ai-typesafe'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });

    it('throws at construction with DecisionProviderUnavailableError when a peer is absent', () => {
      let loads = 0;
      const absent = {
        resolve: () => {
          throw missing;
        },
        load: () => {
          loads += 1;
          return importTypesafePeers.load();
        },
      };

      let failure: unknown;
      try {
        createTypesafeJev({ apiKey: REPLAY_KEY }, absent);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(DecisionProviderUnavailableError);
      expect((failure as DecisionProviderUnavailableError).provider).toBe('typesafe');
      expect((failure as Error).cause).toBe(missing);
      expect((failure as Error).message).not.toContain(REPLAY_KEY);
      expect(loads).toBe(0);
    });

    it('resolves the real peers synchronously and imports nothing until the first decide', () => {
      expect(() => importTypesafePeers.resolve()).not.toThrow();
      const model = typesafeJev({ apiKey: REPLAY_KEY });
      expect(model.kinds.has('boolean')).toBe(true);
    });

    it('shares one import across concurrent decides and does not cache a failed import', async () => {
      let loads = 0;
      let failNext = true;
      const flaky = {
        resolve: () => undefined,
        load: async () => {
          loads += 1;
          if (failNext) {
            failNext = false;
            throw missing;
          }
          return importTypesafePeers.load();
        },
      };
      const fixtureFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        replayFetch(input, init)) as typeof fetch;
      const model = createTypesafeJev({ apiKey: REPLAY_KEY, fetch: fixtureFetch }, flaky);
      const request = decisionScenarios[0]!.request;

      const failure = await model.decide(request).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DecisionProviderUnavailableError);
      expect(loads).toBe(1);

      const [first, second] = await Promise.all([model.decide(request), model.decide(request)]);
      expect(first.value).toBe(second.value);
      expect(loads).toBe(2);
    });
  });
});
