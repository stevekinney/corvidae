/**
 * What the "goal check" captures of `15-view-states.spec.ts` need (COR-2124): the checks the
 * Bureau lists, each verdict an attempt can have, and the ways a test answers the goal pages'
 * requests as the server would. Every capture is of the real application against the real host;
 * only the requests named here are answered by the test, and every other request goes through.
 *
 * The state of a capture is named `goal-check-…`, so none overwrites a capture another source
 * (the showcase's `/goals…` pages, or the stress world's) takes of the same route.
 */
import type { Page } from '@playwright/test';

import { GOALS_COPY } from '../../src/app/copy/goals.ts';
import { expect } from './fixtures.ts';

/** The goal the sample world seeds, which has one attempt (`29-goals.spec.ts`). */
export const SEEDED_GOAL = 'seeded-goal';

/** A check the host builds in, with one setting. */
export const CONTAINS_PHRASE = {
  name: 'contains-phrase',
  version: '1',
  determinism: 'deterministic',
  configuration: {
    type: 'object',
    properties: {
      phrase: {
        type: 'string',
        minLength: 1,
        title: 'Phrase',
        description: 'The words the answer must hold.',
      },
    },
    required: ['phrase'],
    additionalProperties: false,
  },
  source: { kind: 'bureau', name: 'bureau', version: '1.0.0' },
} as const;

/** A check a plugin ships, with no settings. */
export const DEMO_ACCEPTS_ANYTHING = {
  name: 'demo:accepts-any-answer',
  version: '1',
  determinism: 'deterministic',
  configuration: null,
  source: { kind: 'plugin', name: 'demo', version: '1.2.0' },
} as const;

/** A second plugin check, so a plugin's group holds more than one. */
export const DEMO_NEVER_PASSES = {
  name: 'demo:never-passes',
  version: '1',
  determinism: 'deterministic',
  configuration: null,
  source: { kind: 'plugin', name: 'demo', version: '1.2.0' },
} as const;

/** A check the owner wrote as a file. */
export const OWN_STAGING_NOTES = {
  name: 'staging-notes',
  version: '5a1c0e7b9d2f',
  determinism: 'deterministic',
  configuration: null,
  source: { kind: 'bungalow', name: 'bungalow', version: '5a1c0e7b9d2f' },
} as const;

/** Every source at once: the picker's groups. */
export const ALL_SOURCES = [
  CONTAINS_PHRASE,
  DEMO_ACCEPTS_ANYTHING,
  DEMO_NEVER_PASSES,
  OWN_STAGING_NOTES,
] as const;

/** What `bureau.goals.verdict` answers for the seeded goal's first attempt, before the test changes some of it. */
const VERDICT_BASE = {
  goalRunId: SEEDED_GOAL,
  attemptId: `${SEEDED_GOAL}:a0`,
  attemptIndex: 0,
  outcome: 'pass',
  feedback: null,
  retryable: null,
  evidence: [],
  reason: null,
  error: null,
  validator: { name: 'contains-phrase', version: '1' },
  configuration: { phrase: 'staging fix' },
  judgedBy: {
    validator: { name: 'contains-phrase', version: '1' },
    source: { kind: 'bureau', name: 'bureau', version: '1.0.0' },
    configuration: { phrase: 'staging fix' },
  },
  startedAt: '2026-11-02T16:30:00.000Z',
  completedAt: '2026-11-02T16:30:02.000Z',
} as const;

/** The verdicts the drawer shows, by the name each capture has. */
export const VERDICTS = {
  pass: { ...VERDICT_BASE },
  'fail-with-feedback-and-evidence': {
    ...VERDICT_BASE,
    outcome: 'fail',
    feedback: 'The answer doesn’t mention “staging fix”. Say what was changed and where.',
    retryable: true,
    evidence: [
      { source: 'contains-phrase', detail: { phrase: 'staging fix', found: false } },
      { source: 'answer', detail: { excerpt: 'I updated the notes for the release.' } },
    ],
  },
  'error-with-detail': {
    ...VERDICT_BASE,
    outcome: 'error',
    error: { kind: 'run', code: 'VALIDATOR_FAILED', message: 'The check threw while it ran.' },
  },
  'unavailable-with-detail': {
    ...VERDICT_BASE,
    outcome: 'unavailable',
    error: {
      kind: 'load',
      code: 'VALIDATOR_MISSING',
      message: 'The validator contains-phrase is not installed.',
    },
  },
  'judge-unknown': { ...VERDICT_BASE, judgedBy: null },
  'judge-with-reason': {
    ...VERDICT_BASE,
    outcome: 'fail',
    feedback: 'The notes read as a changelog, not release notes.',
    reason: 'The rubric asks for a paragraph a customer could read; this is a list of commits.',
    validator: OWN_STAGING_NOTES,
    configuration: null,
    judgedBy: {
      validator: { name: 'staging-notes', version: '5a1c0e7b9d2f' },
      source: OWN_STAGING_NOTES.source,
      configuration: null,
    },
  },
} as const;

/** A JSON-RPC body for `method`, answered by `handler`. */
type RpcBody = { id?: unknown; method?: string; params?: Record<string, unknown> };

/** Answers `method` with `result`, as the server would; every other request goes through. */
export async function answerWith(page: Page, method: string, result: unknown): Promise<void> {
  await page.route('**/jsonrpc', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as RpcBody;
    if (body.method !== method) {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result } });
  });
}

/** Never answers `method`: the request stays pending for as long as the page is open (a loading state). */
export async function holdMethod(page: Page, method: string): Promise<void> {
  await page.route('**/jsonrpc', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as RpcBody;
    if (body.method !== method) await route.fallback();
    // Held: neither fulfilled nor continued.
  });
}

/**
 * Answers `method` with a fault of `status`, as the server does for one it refuses: a `weftCode`
 * and a message, and `data` beside them. Chromium logs each such response, so the test says so
 * with `pageErrors.expectEvery(loggedFailedResponse(status, /\/bureau\/jsonrpc/))`.
 */
export async function refuseMethod(
  page: Page,
  method: string,
  status: number,
  fault: { readonly weftCode: string; readonly message: string; readonly data?: object },
): Promise<void> {
  await page.route('**/jsonrpc', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as RpcBody;
    if (body.method !== method) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status,
      json: {
        jsonrpc: '2.0',
        id: body.id,
        error: {
          code: -32000,
          message: fault.message,
          data: { weftCode: fault.weftCode, httpStatus: status, ...fault.data },
        },
      },
    });
  });
}

/**
 * Answers `method` with a recorded answer of a real Bureau, byte for byte (only the JSON-RPC `id`
 * is the request's own, as the server echoes it), with the HTTP status the Bureau sent it under.
 */
export async function answerAsRecorded(
  page: Page,
  method: string,
  recorded: { readonly error: { readonly data: { readonly httpStatus: number } } },
): Promise<void> {
  await page.route('**/jsonrpc', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as RpcBody;
    if (body.method !== method) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: recorded.error.data.httpStatus,
      json: { ...recorded, id: body.id },
    });
  });
}

/**
 * Lets `method` through to the host and changes what it answers: `change` is given the result and
 * answers the one the page gets. The seeded goal's owner or settings are changed this way.
 */
export async function patchResult(
  page: Page,
  method: string,
  change: (result: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  await page.route('**/jsonrpc', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as RpcBody;
    if (body.method !== method) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const answered = (await response.json()) as { result?: Record<string, unknown> };
    if (answered.result === undefined) {
      await route.fulfill({ response });
      return;
    }
    await route.fulfill({ response, json: { ...answered, result: change(answered.result) } });
  });
}

/** The check picker of the goal form: a listbox select, drawn as a button with `role="combobox"`. */
export const checkPicker = (page: Page) =>
  page.getByRole('combobox', { name: GOALS_COPY.form.checkLabel });

/**
 * Opens the check picker as `29-goals.spec.ts` does: wait until it is enabled (the Bureau has
 * listed its checks), click the combobox, and the options are the page's `option` roles. The
 * trigger says it is open by `aria-expanded`; no `listbox` element is waited on, because the
 * options are what a person chooses from.
 */
export async function openPicker(page: Page): Promise<void> {
  const picker = checkPicker(page);
  await expect(picker).toBeEnabled();
  await picker.click();
  await expect(picker).toHaveAttribute('aria-expanded', 'true');
}

/** Chooses the option named `name` from the check picker. */
export async function chooseCheck(page: Page, name: RegExp): Promise<void> {
  await openPicker(page);
  await page.getByRole('option', { name }).click();
}

/** The Verdict button of the seeded goal's first attempt row. */
export function verdictButton(page: Page) {
  return page
    .locator('[data-attempt]')
    .first()
    .getByRole('button', { name: GOALS_COPY.detail.verdict.action });
}
