import { CatalogClientError } from '@lostgradient/backchannel/client';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { compileModule } from 'svelte/compiler';

it('compiles the approval action state for both Svelte targets', async () => {
  const source = await Bun.file(
    new URL('./tool-approval-actions.svelte.ts', import.meta.url),
  ).text();
  const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
  for (const generate of ['client', 'server'] as const) {
    expect(() =>
      compileModule(javascript, { filename: 'tool-approval-actions.svelte.js', generate }),
    ).not.toThrow();
  }
});

it('validates direct-host reads and receipts before acting', async () => {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL('./tool-approval-actions.svelte.ts', import.meta.url))],
    target: 'bun',
    plugins: [
      {
        name: 'svelte-module',
        setup(builder) {
          builder.onLoad({ filter: /\.svelte\.ts$/u }, async ({ path }) => ({
            loader: 'js',
            contents: compileModule(
              new Bun.Transpiler({ loader: 'ts' }).transformSync(await Bun.file(path).text()),
              { filename: path, generate: 'server' },
            ).js.code,
          }));
        },
      },
    ],
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(await build.outputs[0].text()).toString('base64')}`
  );
  const review = {
    source: 'bureau',
    id: 'approval:1',
    runId: 'run:1',
    sessionId: 'session:1',
    requestedAt: 1,
    ageMilliseconds: 0,
    round: 0,
    kind: 'tool-approval',
    status: 'pending',
    approval: {
      callId: 'call:1',
      toolName: 'send',
      arguments: {},
      action: { type: 'input' },
      mayRemember: true,
    },
  };
  for (const malformedRead of [true, false]) {
    let writes = 0;
    let reads = 0;
    let notify!: () => void;
    const reported = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const outcomes: string[] = [];
    const host = {
      disposed: false,
      async call(name: string) {
        if (name.endsWith('.get')) {
          if (++reads > 1) throw new Error('read unavailable');
          return malformedRead ? { ...review, effect: 'refund' } : review;
        }
        writes++;
        return {
          id: review.id,
          kind: 'tool-approval',
          decision: 'approve',
          receipt: 'applied',
          privateField: 'secret',
        };
      },
      invalidate() {},
    };
    const actions = module.useToolApprovalActions({
      catalog: host,
      authorized: () => true,
      onOutcome: (_seen: unknown, outcome: string) => {
        outcomes.push(outcome);
        notify();
      },
    })(review);
    actions.remember();
    await reported;
    expect(outcomes).toEqual([malformedRead ? 'failed' : 'unknown-after-dispatch']);
    expect(writes).toBe(malformedRead ? 0 : 1);
    if (!malformedRead) {
      actions.deny();
      expect(actions.disabled).toBe(true);
      expect(writes).toBe(1);
    }
  }
});

it('distinguishes a typed Forbidden refusal from a lost response for the same target', async () => {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL('./tool-approval-actions.svelte.ts', import.meta.url))],
    target: 'bun',
    plugins: [
      {
        name: 'svelte-module',
        setup(builder) {
          builder.onLoad({ filter: /\.svelte\.ts$/u }, async ({ path }) => ({
            loader: 'js',
            contents: compileModule(
              new Bun.Transpiler({ loader: 'ts' }).transformSync(await Bun.file(path).text()),
              { filename: path, generate: 'server' },
            ).js.code,
          }));
        },
      },
    ],
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(await build.outputs[0].text()).toString('base64')}`
  );
  const review = {
    id: 'approval:1',
    source: 'bureau',
    runId: 'run:1',
    sessionId: 'session:1',
    requestedAt: 1,
    ageMilliseconds: 0,
    round: 0,
    kind: 'tool-approval',
    status: 'pending',
    approval: { callId: 'call:1', toolName: 'send', arguments: {}, action: { type: 'input' } },
  };
  for (const refused of [true, false]) {
    let reads = 0;
    const writes: unknown[] = [];
    const outcomes: string[] = [];
    let notify!: () => void;
    const reported = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const host = {
      disposed: false,
      async call(name: string, input: unknown) {
        if (name.endsWith('.get')) {
          if (++reads > 1) throw new Error('read unavailable');
          return review;
        }
        writes.push(input);
        if (refused)
          throw new CatalogClientError(name, {
            code: -32003,
            message: 'Forbidden',
            data: { weftCode: 'Forbidden', httpStatus: 403 },
          });
        throw new Error('response lost');
      },
      invalidate() {},
    };
    const actions = module.useToolApprovalActions({
      catalog: host,
      authorized: () => true,
      onOutcome: (_seen: unknown, outcome: string) => {
        outcomes.push(outcome);
        notify();
      },
    })(review);
    actions.approve();
    await reported;
    expect(outcomes).toEqual([refused ? 'failed' : 'unknown-after-dispatch']);
    expect(writes).toEqual([{ id: review.id, round: 0, decision: 'approve' }]);
    if (refused) {
      await waitUntil(() => !actions.disabled);
      expect(reads).toBe(1);
    } else {
      actions.deny();
      expect(actions.disabled).toBe(true);
      expect(writes).toHaveLength(1);
    }
  }
});

it('fences duplicate actions before the first read completes', async () => {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL('./tool-approval-actions.svelte.ts', import.meta.url))],
    target: 'bun',
    plugins: [
      {
        name: 'svelte-module',
        setup(builder) {
          builder.onLoad({ filter: /\.svelte\.ts$/u }, async ({ path }) => {
            const source = await Bun.file(path).text();
            return {
              loader: 'js',
              contents: compileModule(new Bun.Transpiler({ loader: 'ts' }).transformSync(source), {
                filename: path,
                generate: 'server',
              }).js.code,
            };
          });
        },
      },
    ],
  });
  expect(build.success).toBe(true);
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(await build.outputs[0].text()).toString('base64')}`
  );
  let completeRead!: (value: unknown) => void;
  const read = new Promise((resolve) => {
    completeRead = resolve;
  });
  let writes = 0;
  let decision: unknown;
  let complete!: () => void;
  let receivedReceipt: unknown;
  const outcome = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const review = {
    id: 'review',
    source: 'bureau',
    runId: 'run:1',
    sessionId: 'session:1',
    requestedAt: 1,
    ageMilliseconds: 0,
    round: 1,
    kind: 'tool-approval',
    status: 'pending',
    approval: {
      callId: 'call:1',
      toolName: 'send',
      arguments: {},
      action: { type: 'input' },
      mayRemember: true,
    },
  };
  const host = {
    disposed: false,
    call: async (name: string, input: unknown) =>
      name.endsWith('.get')
        ? read
        : ((decision = input),
          ++writes,
          {
            id: 'review',
            kind: 'tool-approval',
            decision: 'approve',
            receipt: 'applied',
            remembered: false,
          }),
    invalidate() {},
  };
  const actions = module.useToolApprovalActions({
    catalog: host,
    authorized: () => true,
    onOutcome: (_seen: unknown, _outcome: unknown, receipt: unknown) => {
      receivedReceipt = receipt;
      complete();
    },
  })(review);
  actions.approve('  note  ');
  actions.deny();
  expect(actions.disabled).toBe(true);
  completeRead(review);
  await outcome;
  expect(writes).toBe(1);
  expect(receivedReceipt).toMatchObject({ remembered: false });
  expect(decision).toMatchObject({ id: 'review', round: 1, decision: 'approve', reason: 'note' });
});

it('keeps a lost response fenced until a read succeeds', async () => {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL('./tool-approval-actions.svelte.ts', import.meta.url))],
    target: 'bun',
    plugins: [
      {
        name: 'svelte-module',
        setup(builder) {
          builder.onLoad({ filter: /\.svelte\.ts$/u }, async ({ path }) => ({
            loader: 'js',
            contents: compileModule(
              new Bun.Transpiler({ loader: 'ts' }).transformSync(await Bun.file(path).text()),
              { filename: path, generate: 'server' },
            ).js.code,
          }));
        },
      },
    ],
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(await build.outputs[0].text()).toString('base64')}`
  );
  const review = {
    id: 'review',
    source: 'bureau',
    runId: 'run:1',
    sessionId: 'session:1',
    requestedAt: 1,
    ageMilliseconds: 0,
    round: 1,
    kind: 'tool-approval',
    status: 'pending',
    approval: {
      callId: 'call:1',
      toolName: 'send',
      arguments: {},
      action: { type: 'input' },
      mayRemember: true,
    },
  };
  let reads = 0;
  let writes = 0;
  let recover = false;
  const invalidations: string[][] = [];
  let notify!: () => void;
  const reported = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const host = {
    disposed: false,
    async call(name: string) {
      if (name.endsWith('.resolve')) {
        writes++;
        throw new Error('lost response');
      }
      if (++reads > 1 && !recover) throw new Error('offline');
      return review;
    },
    invalidate(operations: string[]) {
      invalidations.push(operations);
    },
  };
  const outcomes: string[] = [];
  const actions = module.useToolApprovalActions({
    catalog: host,
    authorized: () => true,
    onOutcome: (_seen: unknown, outcome: string) => {
      outcomes.push(outcome);
      notify();
    },
  })(review);
  actions.approve();
  await reported;
  expect(outcomes).toEqual(['unknown-after-dispatch']);
  expect(actions.disabled).toBe(true);
  actions.deny();
  expect(writes).toBe(1);
  recover = true;
  await waitUntil(async () => {
    await actions.reconcile();
    return !actions.disabled;
  });
  expect(actions.disabled).toBe(false);
  expect(invalidations).toEqual([['bureau.reviews.list', 'bureau.reviews.get']]);
});

it('uses fresh round and policy and suppresses results after authority changes', async () => {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL('./tool-approval-actions.svelte.ts', import.meta.url))],
    target: 'bun',
    plugins: [
      {
        name: 'svelte-module',
        setup(builder) {
          builder.onLoad({ filter: /\.svelte\.ts$/u }, async ({ path }) => ({
            loader: 'js',
            contents: compileModule(
              new Bun.Transpiler({ loader: 'ts' }).transformSync(await Bun.file(path).text()),
              { filename: path, generate: 'server' },
            ).js.code,
          }));
        },
      },
    ],
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(await build.outputs[0].text()).toString('base64')}`
  );
  const review = {
    id: 'review',
    source: 'bureau',
    runId: 'run:1',
    sessionId: 'session:1',
    requestedAt: 1,
    ageMilliseconds: 0,
    round: 1,
    kind: 'tool-approval',
    status: 'pending',
    approval: {
      callId: 'call:1',
      toolName: 'send',
      arguments: {},
      action: { type: 'input' },
      mayRemember: true,
    },
  };
  let complete!: () => void;
  const next = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const outcomes: string[] = [];
  let current = { ...review, round: 2 };
  let writes = 0;
  const host = {
    disposed: false,
    async call(name: string) {
      if (name.endsWith('.get')) return current;
      writes++;
      return { id: 'review', kind: 'tool-approval', decision: 'approve', receipt: 'applied' };
    },
    invalidate() {},
  };
  const actions = module.useToolApprovalActions({
    catalog: host,
    authorized: () => true,
    onOutcome: (_seen: unknown, outcome: string) => {
      outcomes.push(outcome);
      complete();
    },
  })(review);
  actions.approve();
  await next;
  expect(outcomes).toEqual(['round-changed']);
  expect(writes).toBe(0);
  expect(actions.disabled).toBe(true);

  let authorized = true;
  let release!: (value: unknown) => void;
  const read = new Promise((resolve) => {
    release = resolve;
  });
  const switchedHost = { ...host, call: async () => read };
  const switched = module.useToolApprovalActions({
    catalog: switchedHost,
    authorized: () => authorized,
    onOutcome: () => {
      throw new Error('stale scope received an outcome');
    },
  })(review);
  switched.approve();
  authorized = false;
  release(review);
  await waitUntil(() => switched.disabled);
  expect(writes).toBe(0);

  current = { ...review, approval: { ...review.approval, mayRemember: false } };
  const policyHost = { ...host };
  const policyActions = module.useToolApprovalActions({
    catalog: policyHost,
    authorized: () => true,
    onOutcome: (_seen: unknown, outcome: string) => {
      outcomes.push(outcome);
      complete();
    },
  })(review);
  policyActions.remember();
  await waitUntil(() => !policyActions.disabled);
  expect(writes).toBe(0);
});

it('reports distinct receipts and conflicts and rereads each conflict', async () => {
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL('./tool-approval-actions.svelte.ts', import.meta.url))],
    target: 'bun',
    plugins: [
      {
        name: 'svelte-module',
        setup(builder) {
          builder.onLoad({ filter: /\.svelte\.ts$/u }, async ({ path }) => ({
            loader: 'js',
            contents: compileModule(
              new Bun.Transpiler({ loader: 'ts' }).transformSync(await Bun.file(path).text()),
              { filename: path, generate: 'server' },
            ).js.code,
          }));
        },
      },
    ],
  });
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(await build.outputs[0].text()).toString('base64')}`
  );
  const review = {
    id: 'review',
    source: 'bureau',
    runId: 'run:1',
    sessionId: 'session:1',
    requestedAt: 1,
    ageMilliseconds: 0,
    round: 1,
    kind: 'tool-approval',
    status: 'pending',
    approval: {
      callId: 'call:1',
      toolName: 'send',
      arguments: {},
      action: { type: 'input' },
      mayRemember: true,
    },
  };
  const cases = [
    [{ receipt: 'applied' }, 'applied'],
    [{ receipt: 'superseded' }, 'superseded'],
    [{ receipt: 'rejected' }, 'failed'],
    [{ receipt: 'invalid' }, 'unknown-after-dispatch'],
    [{ receipt: 'applied', warning: 'APPROVAL_OUTCOME_NOT_WRITTEN' }, 'outcome-not-written'],
    [{ data: { reason: 'REVIEW_ALREADY_RESOLVED' } }, 'already-resolved'],
    [{ data: { reason: 'REVIEW_ROUND_CHANGED' } }, 'round-changed'],
  ] as const;
  for (const [reply, expected] of cases) {
    let reads = 0;
    const invalidations: string[][] = [];
    let done!: () => void;
    const reported = new Promise<void>((resolve) => {
      done = resolve;
    });
    const outcomes: string[] = [];
    const host = {
      disposed: false,
      async call(name: string) {
        if (name.endsWith('.get')) {
          reads++;
          return review;
        }
        if ('data' in reply) throw reply;
        return { id: 'review', kind: 'tool-approval', decision: 'approve', ...reply };
      },
      invalidate(operations: string[]) {
        invalidations.push(operations);
      },
    };
    const actions = module.useToolApprovalActions({
      catalog: host,
      authorized: () => true,
      onOutcome: (_seen: unknown, value: string) => {
        outcomes.push(value);
        done();
      },
    })(review);
    actions.approve();
    await reported;
    expect(outcomes).toEqual([expected]);
    if ('data' in reply) await waitUntil(() => reads === 2);
    await waitUntil(() => invalidations.length === 1);
    expect(invalidations).toEqual([['bureau.reviews.list', 'bureau.reviews.get']]);
  }
  const refund = { ...review, effect: { kind: 'refund' } };
  const refundHost = { disposed: false, call: async () => refund, invalidate() {} };
  const refundActions = module.useToolApprovalActions({
    catalog: refundHost,
    authorized: () => true,
  })(refund);
  expect(refundActions.canRemember).toBe(false);
  const unverified = module.useToolApprovalActions({ catalog: refundHost, authorized: () => true })(
    { ...review, round: undefined },
  );
  expect(unverified.disabled).toBe(true);

  let releaseReceipt!: (value: unknown) => void;
  let notifyDispatched!: () => void;
  const receipt = new Promise((resolve) => {
    releaseReceipt = resolve;
  });
  const dispatched = new Promise<void>((resolve) => {
    notifyDispatched = resolve;
  });
  let returned = false;
  let leaked = false;
  const disposedHost = {
    disposed: false,
    async call(name: string) {
      if (name.endsWith('.get')) return review;
      notifyDispatched();
      const result = await receipt;
      returned = true;
      return result;
    },
    invalidate() {
      leaked = true;
    },
  };
  const disposedActions = module.useToolApprovalActions({
    catalog: disposedHost,
    authorized: () => true,
    onOutcome: () => {
      leaked = true;
    },
  })(review);
  disposedActions.approve();
  await dispatched;
  disposedHost.disposed = true;
  releaseReceipt({ id: 'review', kind: 'tool-approval', decision: 'approve', receipt: 'applied' });
  await waitUntil(() => returned);
  expect(leaked).toBe(false);
});
