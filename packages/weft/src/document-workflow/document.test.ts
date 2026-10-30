import { describe, expect, it } from 'bun:test';

import {
  WorkflowDocumentValidationError,
  canonicalWorkflowDocumentJson,
  validateWorkflowDocument,
  workflowDocumentSchema,
  workflowDocumentVersion,
  type DocumentWorkflowHost,
  type WorkflowDocument,
} from './document.ts';

const host: DocumentWorkflowHost = {
  activities: {
    notify: ({ input }) => input,
    summarize: ({ previous }) => previous,
    'payments.charge': () => null,
  },
  triggerKinds: {
    schedule: (trigger) =>
      typeof trigger['cron'] === 'string' ? undefined : 'schedule triggers need a cron string',
    manual: () => undefined,
  },
};

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'daily-digest',
    trigger: { kind: 'schedule', cron: '0 9 * * *' },
    steps: [
      { kind: 'activity', handler: 'summarize', input: { window: '24h' } },
      { kind: 'sleep', duration: '5m' },
      { kind: 'await-signal', signal: 'approve' },
      { kind: 'activity', handler: 'notify' },
    ],
    ...overrides,
  };
}

function issuesOf(input: unknown): readonly { path: string; message: string }[] {
  try {
    validateWorkflowDocument(input, host);
  } catch (error) {
    if (error instanceof WorkflowDocumentValidationError) return error.issues;
    throw error;
  }
  throw new Error('expected validateWorkflowDocument to throw');
}

describe('validateWorkflowDocument()', () => {
  it('accepts a document whose handlers and trigger kind the host registered', () => {
    const validated = validateWorkflowDocument(document(), host);

    expect(validated.name).toBe('daily-digest');
    expect(validated.steps).toHaveLength(4);
  });

  it('returns a detached copy, so later mutation of the caller input cannot change the document', () => {
    const input = document();
    const validated = validateWorkflowDocument(input, host);
    (input['steps'] as unknown[]).length = 0;

    expect(validated.steps).toHaveLength(4);
  });

  it('rejects a document that names an unregistered activity handler at write time', () => {
    const issues = issuesOf(
      document({ steps: [{ kind: 'activity', handler: 'delete-everything' }] }),
    );

    expect(issues).toEqual([
      {
        path: 'steps[0].handler',
        message: 'activity handler "delete-everything" is not registered',
      },
    ]);
  });

  it('rejects a handler name that is not wire-safe with the typed error and its path', () => {
    const issues = issuesOf(
      document({ steps: [{ kind: 'activity', handler: 'payments.charge' }] }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('steps[0].handler');
    expect(issues[0]?.message).toContain('payments.charge');
  });

  it('does not resolve handler names through the prototype chain', () => {
    const issues = issuesOf(document({ steps: [{ kind: 'activity', handler: 'constructor' }] }));

    expect(issues.map((issue) => issue.path)).toEqual(['steps[0].handler']);
  });

  it('rejects a document that names an unregistered trigger kind at write time', () => {
    const issues = issuesOf(document({ trigger: { kind: 'webhook' } }));

    expect(issues).toEqual([
      { path: 'trigger.kind', message: 'trigger kind "webhook" is not registered' },
    ]);
  });

  it("reports the trigger kind validator's reason", () => {
    const issues = issuesOf(document({ trigger: { kind: 'schedule' } }));

    expect(issues).toEqual([{ path: 'trigger', message: 'schedule triggers need a cron string' }]);
  });

  it('has no owner or author field: the schema rejects one', () => {
    expect(Object.keys(workflowDocumentSchema.shape).toSorted()).toEqual([
      'inputSchema',
      'name',
      'outputSchema',
      'steps',
      'trigger',
    ]);
    expect(issuesOf(document({ owner: 'steve' })).map((issue) => issue.path)).toEqual(['']);
  });

  it.each([
    ['a missing name', { name: undefined }, 'name'],
    ['a name outside the wire-safe grammar', { name: 'not.valid' }, 'name'],
    ['an empty step list', { steps: [] }, 'steps'],
    ['an unknown step kind', { steps: [{ kind: 'branch' }] }, 'steps[0].kind'],
    [
      'an invalid sleep duration',
      { steps: [{ kind: 'sleep', duration: 'soon' }] },
      'steps[0].duration',
    ],
    ['an empty signal name', { steps: [{ kind: 'await-signal', signal: '' }] }, 'steps[0].signal'],
    [
      'a non-JSON activity input',
      { steps: [{ kind: 'activity', handler: 'notify', input: () => 1 }] },
      'steps[0].input',
    ],
    ['a trigger without a kind', { trigger: { cron: '* * * * *' } }, 'trigger.kind'],
    [
      'a trigger holding a non-JSON value',
      { trigger: { kind: 'manual', hook: () => 1 } },
      'trigger',
    ],
    ['a non-object document', undefined, ''],
  ])('rejects %s', (_label, overrides, path) => {
    const input = overrides === undefined ? 'nope' : document(overrides);
    expect(issuesOf(input).map((issue) => issue.path)).toContain(path);
  });
});

describe('workflowDocumentSchema trigger JSON values', () => {
  it('names the non-JSON trigger value in the issue message', () => {
    const result = workflowDocumentSchema.safeParse(
      document({ trigger: { kind: 'manual', at: new Date(0) } }),
    );

    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected rejection');
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      'must contain only JSON values',
    );
  });
});

describe('canonicalWorkflowDocumentJson()', () => {
  it('sorts keys at every depth and writes no insignificant whitespace', () => {
    const canonical = canonicalWorkflowDocumentJson({
      steps: [{ input: { b: 1, a: [2, { d: 1, c: 2 }] }, handler: 'notify', kind: 'activity' }],
      trigger: { kind: 'manual' },
      name: 'x',
    });

    expect(canonical).toBe(
      '{"name":"x","steps":[{"handler":"notify","input":{"a":[2,{"c":2,"d":1}],"b":1},"kind":"activity"}],"trigger":{"kind":"manual"}}',
    );
  });

  it('keeps an own "__proto__" key as data', () => {
    const input = JSON.parse('{"kind":"manual","__proto__":{"x":1}}') as Record<string, never>;
    const canonical = canonicalWorkflowDocumentJson({
      name: 'x',
      trigger: input,
      steps: [],
    } as unknown as WorkflowDocument);

    expect(canonical).toContain('"__proto__":{"x":1}');
  });
});

describe('workflowDocumentVersion()', () => {
  it('pins the version of a fixed document through the full validate-then-hash path', async () => {
    // The expected hex is the SHA-256 of this exact text, computed outside Weft with
    // Python's hashlib over a canonicalizer that sorts keys by UTF-16 code unit. The
    // trigger's two non-ASCII keys sort differently by code point, so the hash also
    // fails if the ordering ever changes from code units.
    // A change here means every stored document's version moved: that is a
    // one-way-door change, never a refactor.
    const canonical =
      '{"name":"golden-digest","steps":[{"handler":"summarize","input":{"limit":10,"window":"24h"},"kind":"activity"},{"duration":"5m","kind":"sleep"},{"kind":"await-signal","signal":"approve"},{"handler":"notify","kind":"activity"}],"trigger":{"cron":"0 9 * * *","kind":"schedule","😀":2,"Ａ":1}}';
    const validated = validateWorkflowDocument(
      {
        trigger: { kind: 'schedule', cron: '0 9 * * *', '\uff21': 1, '\u{1F600}': 2 },
        steps: [
          { input: { window: '24h', limit: 10 }, handler: 'summarize', kind: 'activity' },
          { duration: '5m', kind: 'sleep' },
          { signal: 'approve', kind: 'await-signal' },
          { handler: 'notify', kind: 'activity' },
        ],
        name: 'golden-digest',
      },
      host,
    );

    expect(canonicalWorkflowDocumentJson(validated)).toBe(canonical);
    expect(await workflowDocumentVersion(validated)).toBe(
      'sha256:9c62d90811ab3a69d5f23d86061fe839e8c7fc55d7750cc6cf2129a1f38863b6',
    );
  });

  it('hashes content, not meaning: absent and null input, and 1m and 60000, differ', async () => {
    const version = async (step: Record<string, unknown>) =>
      workflowDocumentVersion(validateWorkflowDocument(document({ steps: [step] }), host));

    expect(await version({ kind: 'activity', handler: 'notify' })).not.toBe(
      await version({ kind: 'activity', handler: 'notify', input: null }),
    );
    expect(await version({ kind: 'sleep', duration: '1m' })).not.toBe(
      await version({ kind: 'sleep', duration: 60_000 }),
    );
  });

  it('is the SHA-256 of the canonical JSON, tagged sha256', async () => {
    const validated = validateWorkflowDocument(document(), host);
    const expected = new Bun.CryptoHasher('sha256')
      .update(canonicalWorkflowDocumentJson(validated))
      .digest('hex');

    expect(await workflowDocumentVersion(validated)).toBe(`sha256:${expected}`);
  });

  it('gives the same version to identical content however its keys are ordered', async () => {
    const first = validateWorkflowDocument(document(), host);
    const reordered = validateWorkflowDocument(
      {
        steps: (document()['steps'] as Record<string, unknown>[]).map((step) =>
          Object.fromEntries(Object.entries(step).toReversed()),
        ),
        trigger: { cron: '0 9 * * *', kind: 'schedule' },
        name: 'daily-digest',
      },
      host,
    );

    expect(await workflowDocumentVersion(reordered)).toBe(await workflowDocumentVersion(first));
  });

  it('gives a one-step change a different version', async () => {
    const base = document();
    const changed = document({
      steps: [
        { kind: 'activity', handler: 'summarize', input: { window: '48h' } },
        ...(base['steps'] as unknown[]).slice(1),
      ],
    });

    expect(await workflowDocumentVersion(validateWorkflowDocument(changed, host))).not.toBe(
      await workflowDocumentVersion(validateWorkflowDocument(base, host)),
    );
  });
});
