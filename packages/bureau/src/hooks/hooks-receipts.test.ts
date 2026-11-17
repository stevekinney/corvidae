/**
 * COR-2182 (R11) — receipts, a reaction that is not registered, and a stored configuration its
 * reaction's schema now refuses. Each table crosses an input or a failure with every exit it can
 * reach, and `today` is what main did for that row before this change, from a probe run of these
 * same rows (the table was red first).
 *
 * Receipt: what `run` (or `dryRun`) resolves, against the attempt record, the delivery's state and
 * the diagnostics. A field that is not allowed is dropped and never fails the delivery.
 *
 * | input                                  | stored receipt            | delivery  | notices | today (main)                                  |
 * | -------------------------------------- | ------------------------- | --------- | ------- | --------------------------------------------- |
 * | `{ receipt: { id, url https, summary } }` | all three kept         | delivered | 0       | the resolved value is ignored: receipt `{}`   |
 * | `undefined`, `{}`, `{ receipt: {} }`   | `{}`                      | delivered | 0       | `{}` (unchanged)                              |
 * | url `http:`, or not an address         | without `url`             | delivered | 1       | ignored: receipt `{}`                         |
 * | url or id over its limit, or not text  | without that field        | delivered | 1       | ignored: receipt `{}`                         |
 * | summary of 201 characters              | without `summary`         | delivered | 1       | ignored: receipt `{}`                         |
 * | summary of 200 characters              | kept                      | delivered | 0       | ignored: receipt `{}`                         |
 * | `url` and `summary` both refused       | without both              | delivered | 1       | ignored: receipt `{}`                         |
 * | a member the receipt does not name     | not stored                | delivered | 0       | ignored: receipt `{}`                         |
 * | `run` always rejects                   | none                      | exhausted | 0       | none, exhausted (unchanged)                   |
 * | a first attempt rejects, a retry gives | on the retry's attempt    | delivered | 0       | ignored: receipt `{}`                         |
 * | `dryRun` resolves a receipt            | on the test attempt       | delivered | 0       | ignored: receipt `{}`                         |
 * | a resolved secret in `summary` or `id` | the value is `[redacted]` | delivered | 0       | ignored: receipt `{}`                         |
 *
 * Reaction state: a hook whose reaction is registered, then is not (its plugin is disabled, removed
 * or dropped the kind), against dispatch and `list`, and a configuration the schema now refuses.
 *
 * | input                                         | deliveries written | list/get problems                            | today (main)                                  |
 * | --------------------------------------------- | ------------------ | -------------------------------------------- | --------------------------------------------- |
 * | owner hook, reaction not registered           | 0                  | `reaction-unavailable`                       | 1 delivery, ends `failed`; no problems field  |
 * | default hook, plugin not registered           | 0                  | `reaction-unavailable`                       | 1 delivery, ends `failed`; no problems field  |
 * | default hook, plugin removed (withdrawn)      | 0                  | `reaction-unavailable`                       | withdrawn hook matches nothing; no problems   |
 * | reaction registered, configuration valid      | 1, delivered       | none                                         | 1, delivered; no problems field               |
 * | reaction registered, needs setup              | 1, pending         | none                                         | 1, pending (unchanged)                        |
 * | schema now refuses the stored configuration   | 1 (refused at run) | `configuration-invalid` with each path+code  | 1, ends `failed`; no problems field           |
 * | stored `{ "$secret": key }` in a secret field | 1, delivered       | none                                         | 1, delivered; no problems field               |
 * | unregistered and an old configuration         | 0                  | `reaction-unavailable` only                  | 1 delivery, ends `failed`; no problems field  |
 * | a disabled hook, reaction not registered      | 0                  | `reaction-unavailable`                       | none matched; no problems field               |
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { HookActionReceipt } from './hook-types.ts';
import {
  availabilityGate,
  harness,
  reference,
  SECRET_CONFIGURATION,
  SENTINEL,
  secretReader,
  type Harness,
  type HarnessOptions,
} from './hooks-reactions.test-support.ts';

/** What `run` resolves; `unknown` because a plugin's value is checked at runtime. */
type Resolved = unknown;

interface ReceiptRow {
  readonly name: string;
  readonly resolves: Resolved;
  /** The receipt the attempt stores. */
  readonly stored: HookActionReceipt;
  /** How many warnings the host reports for the delivery. */
  readonly notices: number;
}

const URL_OK = 'https://chat.example/messages/42';
const SUMMARY_OK = 'Posted the settled run to #ops';

const RECEIPT_ROWS: readonly ReceiptRow[] = [
  {
    name: 'a receipt with an id, an https url and a summary is kept whole',
    resolves: { receipt: { id: 'msg-42', url: URL_OK, summary: SUMMARY_OK } },
    stored: { id: 'msg-42', url: URL_OK, summary: SUMMARY_OK },
    notices: 0,
  },
  { name: 'nothing resolved stores an empty receipt', resolves: undefined, stored: {}, notices: 0 },
  { name: 'an empty object stores an empty receipt', resolves: {}, stored: {}, notices: 0 },
  {
    name: 'an empty receipt stores an empty receipt',
    resolves: { receipt: {} },
    stored: {},
    notices: 0,
  },
  {
    name: 'an http url is dropped, the rest kept, with one warning',
    resolves: { receipt: { id: 'msg-42', url: 'http://chat.example/messages/42' } },
    stored: { id: 'msg-42' },
    notices: 1,
  },
  {
    name: 'a url that is not an address is dropped, with one warning',
    resolves: { receipt: { url: 'chat.example/messages/42', summary: SUMMARY_OK } },
    stored: { summary: SUMMARY_OK },
    notices: 1,
  },
  {
    name: 'a javascript: url is dropped, with one warning',
    resolves: { receipt: { url: 'javascript:alert(1)' } },
    stored: {},
    notices: 1,
  },
  {
    name: 'a url over 2048 characters is dropped, with one warning',
    resolves: { receipt: { url: `https://chat.example/${'a'.repeat(2048)}` } },
    stored: {},
    notices: 1,
  },
  {
    name: 'an id over 200 characters is dropped, with one warning',
    resolves: { receipt: { id: 'i'.repeat(201), summary: SUMMARY_OK } },
    stored: { summary: SUMMARY_OK },
    notices: 1,
  },
  {
    name: 'a member that is not text is dropped, with one warning',
    resolves: { receipt: { id: 7, url: ['https://chat.example'], summary: SUMMARY_OK } },
    stored: { summary: SUMMARY_OK },
    notices: 1,
  },
  {
    name: 'a summary of 201 characters is dropped, with one warning',
    resolves: { receipt: { id: 'msg-42', summary: 's'.repeat(201) } },
    stored: { id: 'msg-42' },
    notices: 1,
  },
  {
    name: 'a summary of 200 characters is kept',
    resolves: { receipt: { summary: 's'.repeat(200) } },
    stored: { summary: 's'.repeat(200) },
    notices: 0,
  },
  {
    name: 'a url and a summary that are both refused are both dropped, with one warning',
    resolves: { receipt: { id: 'msg-42', url: 'http://x.example', summary: 's'.repeat(201) } },
    stored: { id: 'msg-42' },
    notices: 1,
  },
  {
    name: 'a member the receipt does not name is not stored, and is no warning',
    resolves: { receipt: { id: 'msg-42', token: 'sk-nope', runId: 'run-9' } },
    stored: { id: 'msg-42' },
    notices: 0,
  },
  {
    name: 'a receipt that is not an object is no receipt',
    resolves: { receipt: 'https://chat.example' },
    stored: {},
    notices: 0,
  },
];

/** A harness whose reaction resolves `resolves` from `run`, and the one delivery its hook made. */
async function delivered(resolves: Resolved, options: HarnessOptions = {}) {
  const h = harness({ ...options, run: () => Promise.resolve(resolves as never) });
  const hook = await h.hook();
  await h.open();
  h.dispatch();
  await h.drain();
  return { h, hook, delivery: await h.only(hook.id) };
}

describe('a reaction’s receipt (COR-2182)', () => {
  for (const row of RECEIPT_ROWS) {
    it(row.name, async () => {
      const { h, delivery } = await delivered(row.resolves);

      expect(delivery.status).toBe('delivered');
      expect(delivery.attempts).toHaveLength(1);
      expect(delivery.attempts[0]?.outcome).toBe('completed');
      expect(delivery.attempts[0]?.receipt).toEqual(row.stored);
      expect(h.notices).toHaveLength(row.notices);
    });
  }

  it('reports a dropped field by its name and never with the value the plugin gave', async () => {
    const { h } = await delivered({
      receipt: { url: `http://${SENTINEL}.example`, summary: SENTINEL.repeat(20) },
    });

    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain('url');
    expect(h.notices[0]).toContain('summary');
    expect(h.notices[0]).not.toContain(SENTINEL);
  });

  it('keeps a failed attempt without a receipt, and the retry’s attempt holds the receipt it resolved', async () => {
    const h = harness({
      maxAttempts: 3,
      run: (_context, call) =>
        call === 1
          ? Promise.reject(new Error('the service is busy'))
          : Promise.resolve({ receipt: { id: 'msg-43', summary: SUMMARY_OK } }),
    });
    const hook = await h.hook();
    await h.open();
    h.dispatch();
    await h.drain();

    const delivery = await h.only(hook.id);
    expect(delivery.status).toBe('delivered');
    expect(delivery.attempts.map((attempt) => [attempt.outcome, attempt.receipt])).toEqual([
      ['error', undefined],
      ['completed', { id: 'msg-43', summary: SUMMARY_OK }],
    ]);
  });

  it('ends a delivery whose run always rejects exhausted, with no receipt', async () => {
    const h = harness({ maxAttempts: 3, run: () => Promise.reject(new Error('still busy')) });
    const hook = await h.hook();
    await h.open();
    h.dispatch();
    await h.drain();

    const delivery = await h.only(hook.id);
    expect(delivery.status).toBe('exhausted');
    expect(delivery.attempts.every((attempt) => attempt.receipt === undefined)).toBe(true);
  });

  it('keeps the receipt a dryRun resolves on the test delivery’s attempt', async () => {
    const h = harness({
      dryRun: () => Promise.resolve({ receipt: { id: 'dry-1', url: URL_OK } }),
    });
    const hook = await h.hook();
    await h.open();

    const tested = await h.hooks.test(hook.id);

    expect(tested?.status).toBe('delivered');
    expect(tested?.attempts[0]?.receipt).toEqual({ id: 'dry-1', url: URL_OK });
  });

  it('removes a secret the reaction resolved from the text it keeps, whatever field holds it', async () => {
    const secrets = secretReader({ 'slack-token': SENTINEL });
    const h = harness({
      configuration: SECRET_CONFIGURATION,
      configurationSecrets: secrets,
      run: () =>
        Promise.resolve({
          receipt: { id: `id-${SENTINEL}`, summary: `Used ${SENTINEL} to post` },
        }),
    });
    const hook = await h.hookWith({ channel: 'ops', token: reference('slack-token') });
    await h.open();
    h.dispatch();
    await h.drain();

    const delivery = await h.only(hook.id);
    expect(delivery.status).toBe('delivered');
    expect(delivery.attempts[0]?.receipt).toEqual({
      id: 'id-[redacted]',
      summary: 'Used [redacted] to post',
    });
    expect(JSON.stringify(delivery)).not.toContain(SENTINEL);
  });
});

/** A reaction that is registered for the first harness and, for the second, is not. */
const NONE: HarnessOptions['registrations'] = () => [];

/** Two processes over one store: `first` writes, `second` reads with `options`. */
function restarted(first: HarnessOptions, second: HarnessOptions): [Harness, () => Harness] {
  const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
  const clock = { milliseconds: 1_800_000_000_000 };
  const before = harness({ kv, clock, ...first });
  return [before, () => harness({ kv, clock, ...second })];
}

/** Dispatches an event to `h` and returns the deliveries each of its hooks has. */
async function dispatched(h: Harness, hookId: string) {
  await h.open();
  h.dispatch();
  await h.drain();
  return h.deliveries(hookId);
}

describe('a hook whose reaction is not registered (COR-2182)', () => {
  it('writes no delivery for an owner’s hook, and lists it as unavailable', async () => {
    const [before, after] = restarted({}, { registrations: NONE });
    const hook = await before.hook();
    const h = after();

    expect(await dispatched(h, hook.id)).toEqual([]);
    expect((await h.hooks.list()).map((listed) => listed.problems)).toEqual([
      [{ code: 'reaction-unavailable' }],
    ]);
    expect(h.notices).toEqual([]);
  });

  it('writes no delivery for a default hook whose plugin is not registered, and lists it as unavailable', async () => {
    const [before, after] = restarted({}, { registrations: NONE });
    const [hook] = await before.hooks.reconcileDeclared('slack', [
      {
        name: 'Post settled runs',
        events: ['run.settled'],
        reaction: 'post-message',
        configuration: { channel: 'ops' },
      },
    ]);
    const h = after();

    expect(await dispatched(h, hook!.id)).toEqual([]);
    const [listed] = await h.hooks.list();
    expect(listed?.declaredBy).toEqual({ plugin: 'slack' });
    expect(listed?.problems).toEqual([{ code: 'reaction-unavailable' }]);
  });

  it('lists a default hook its plugin withdrew as unavailable, and writes no delivery', async () => {
    const [before, after] = restarted({}, { registrations: NONE });
    const [hook] = await before.hooks.reconcileDeclared('slack', [
      {
        name: 'Post settled runs',
        events: ['run.settled'],
        reaction: 'post-message',
        configuration: { channel: 'ops' },
      },
    ]);
    const h = after();
    await h.hooks.reconcileDeclared('slack', []);

    expect(await dispatched(h, hook!.id)).toEqual([]);
    const [listed] = await h.hooks.list();
    expect(listed?.declaredBy).toEqual({ plugin: 'slack', withdrawn: true });
    expect(listed?.enabled).toBe(false);
    expect(listed?.problems).toEqual([{ code: 'reaction-unavailable' }]);
  });

  it('lists a disabled hook as unavailable too', async () => {
    const [before, after] = restarted({}, { registrations: NONE });
    const hook = await before.hook();
    await before.hooks.update(hook.id, { enabled: false });
    const h = after();

    expect((await h.hooks.list()).map((listed) => listed.problems)).toEqual([
      [{ code: 'reaction-unavailable' }],
    ]);
  });

  it('keeps writing a delivery for a registered reaction, and one that needs setup waits', async () => {
    const gate = availabilityGate(false);
    const h = harness({ gate });
    const hook = await h.hook();

    const found = await dispatched(h, hook.id);

    expect(found.map((delivery) => delivery.status)).toEqual(['pending']);
    expect((await h.hooks.list()).map((listed) => listed.problems)).toEqual([[]]);
  });
});

describe('a stored configuration its reaction’s schema now refuses (COR-2182)', () => {
  it('lists the schema’s issues as a path and a code each, and no message', async () => {
    const [before, after] = restarted(
      {},
      { configuration: z.object({ channel: z.number(), team: z.string() }) },
    );
    const hook = await before.hook();
    const h = after();

    const [listed] = await h.hooks.list();

    expect(listed?.problems).toEqual([
      {
        code: 'configuration-invalid',
        issues: [
          { path: ['channel'], code: 'invalid_type' },
          { path: ['team'], code: 'invalid_type' },
        ],
      },
    ]);
    expect(JSON.stringify(listed?.problems)).not.toContain('expected');
    expect(listed?.id).toBe(hook.id);
  });

  it('lists a default hook the same way', async () => {
    const [before, after] = restarted(
      {},
      { configuration: z.object({ channel: z.enum(['alerts']) }) },
    );
    await before.hooks.reconcileDeclared('slack', [
      {
        name: 'Post settled runs',
        events: ['run.settled'],
        reaction: 'post-message',
        configuration: { channel: 'ops' },
      },
    ]);
    const h = after();

    const [listed] = await h.hooks.list();

    expect(listed?.problems).toEqual([
      { code: 'configuration-invalid', issues: [{ path: ['channel'], code: 'invalid_value' }] },
    ]);
  });

  it('lists no problem for a stored secret reference in a secret field, and for a valid configuration', async () => {
    const h = harness({ configuration: SECRET_CONFIGURATION });
    await h.hookWith({ channel: 'ops', token: reference('slack-token') });

    expect((await h.hooks.list()).map((listed) => listed.problems)).toEqual([[]]);
  });

  it('lists the reaction as unavailable and nothing else when it is not registered', async () => {
    const [before, after] = restarted({}, { registrations: NONE });
    await before.hookWith({ channel: 'ops', unexpected: true });
    const h = after();

    expect((await h.hooks.list()).map((listed) => listed.problems)).toEqual([
      [{ code: 'reaction-unavailable' }],
    ]);
  });

  it('lists no problem for a hook that is not a plugin hook', async () => {
    const h = harness();
    await h.created.hooks.create({ events: ['run.settled'], action: { type: 'notify' } });

    expect((await h.hooks.list()).map((listed) => listed.problems)).toEqual([[]]);
  });
});
