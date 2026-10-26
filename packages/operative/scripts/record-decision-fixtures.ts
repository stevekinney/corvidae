#!/usr/bin/env bun
// Records the Jev contract fixtures in `test/fixtures/decisions/` by sending each scenario in
// `test/fixtures/decisions/scenarios.ts` to the live TypeSafe API through `typesafeJev`. This is
// the only network path in the decision suite and it runs by hand:
//
//   bun packages/operative/scripts/record-decision-fixtures.ts
//
// The key comes from the macOS Keychain service `typesafe-api`. It is held in one variable and
// never printed, and a fixture that contains it is refused. A fixture holds the request body, the
// response status, and the response body: no headers. Run
// `bunx prettier --write packages/operative/test/fixtures/decisions` afterwards, because the
// repository formats JSON.
//
// The script reads no environment variable on purpose: the repository registers every environment
// read in an `environment-configuration.ts` boundary (`scripts/environment-configuration-policy.ts`).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { typesafeJev } from '../src/decisions/typesafe-jev';
import { decisionScenarios } from '../test/fixtures/decisions/scenarios';

const FIXTURE_DIRECTORY = join(import.meta.dir, '..', 'test', 'fixtures', 'decisions');
const KEYCHAIN_SERVICE = 'typesafe-api';

function resolveApiKey(): string {
  const keychain = Bun.spawnSync(
    ['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
    {
      stdout: 'pipe',
      stderr: 'ignore',
    },
  );
  const fromKeychain = keychain.exitCode === 0 ? keychain.stdout.toString().trim() : '';
  if (fromKeychain === '') {
    throw new Error(`No TypeSafe key: add the Keychain service "${KEYCHAIN_SERVICE}".`);
  }
  return fromKeychain;
}

interface CapturedExchange {
  path: string;
  requestBody: unknown;
  status: number;
  responseBody: unknown;
}

async function record(): Promise<void> {
  const apiKey = resolveApiKey();
  mkdirSync(FIXTURE_DIRECTORY, { recursive: true });

  for (const scenario of decisionScenarios) {
    const exchanges: CapturedExchange[] = [];
    const recordingFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const response = await fetch(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input));
      exchanges.push({
        path: url.pathname,
        requestBody: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        status: response.status,
        responseBody: JSON.parse(await response.clone().text()),
      });
      return response;
    }) as typeof fetch;

    const model = await typesafeJev({ apiKey, fetch: recordingFetch });
    const decision = await model.decide(scenario.request);
    if (decision.value !== scenario.expected) {
      throw new Error(
        `Scenario "${scenario.name}" answered ${JSON.stringify(decision.value)}, expected ${JSON.stringify(scenario.expected)}; no fixture written.`,
      );
    }
    if (exchanges.length !== 1) {
      throw new Error(`Scenario "${scenario.name}" made ${exchanges.length} requests, expected 1.`);
    }

    const text = `${JSON.stringify({ scenario: scenario.name, exchange: exchanges[0] }, null, 2)}\n`;
    if (text.includes(apiKey)) {
      throw new Error(`Scenario "${scenario.name}" would write the API key; no fixture written.`);
    }
    writeFileSync(join(FIXTURE_DIRECTORY, `${scenario.name}.json`), text);
    process.stdout.write(`recorded ${scenario.name}\n`);
  }
}

await record().catch((error: unknown) => {
  // Never echo more than the message: the key is not in any error this script raises.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
