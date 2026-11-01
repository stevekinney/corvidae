/**
 * COR-1980 — the model policy binds the agent files a write saves. A create, an update, a restore
 * or a tried definition that names a model the deployment or the Bureau forbids is refused with the
 * model named and writes nothing; a file saved before the policy tightened is still listed ready and
 * can still be edited to another model. A scan never asks the policy: only a write does.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { readdir } from 'node:fs/promises';

import { AgentFileError, type AgentFileProblem } from './agent-file';
import type { BureauModelPolicyOptions } from './model-policy';
import {
  agentFileText,
  type AgentFileFixture,
  createAgentFileFixture,
  KNOWN_MODEL,
  OTHER_MODEL,
} from './testing/agent-file-fixtures.test-support';

const fixtures: AgentFileFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

let policy: BureauModelPolicyOptions | undefined;

async function start() {
  policy = undefined;
  const fixture = await createAgentFileFixture({ watch: false, modelPolicy: () => policy });
  fixtures.push(fixture);
  return fixture;
}

/** A definition over the models named; `instructions` is required to save. */
const definitionOf = (extra: { model: string; models?: string[] }) => ({
  ...extra,
  instructions: 'Be careful.\n',
});

const DENY_KNOWN: BureauModelPolicyOptions = {
  deployment: { deniedModels: ['claude-opus-5-5'] },
  policyRevision: 3,
};

async function problemOf(work: Promise<unknown> | (() => unknown)): Promise<AgentFileProblem> {
  try {
    await (typeof work === 'function' ? work() : work);
  } catch (error) {
    if (error instanceof AgentFileError && error.problem !== undefined) return error.problem;
    throw error;
  }
  throw new Error('Expected the write to be refused.');
}

describe('a save under a model policy', () => {
  it('refuses to create an agent file whose model the deployment policy denies, naming the model, and writes nothing', async () => {
    const fixture = await start();
    policy = DENY_KNOWN;

    const problem = await problemOf(
      fixture.catalog.create('helper', definitionOf({ model: KNOWN_MODEL })),
    );

    expect(problem.code).toBe('model-policy-denied');
    expect(problem.message).toContain(KNOWN_MODEL);
    expect(problem.message).toContain('deployment');
    expect(problem.issues).toEqual([
      expect.objectContaining({ path: 'model', reference: KNOWN_MODEL }),
    ]);
    expect(await readdir(fixture.directory)).toEqual([]);
    expect(fixture.catalog.list()).toEqual([]);
  });

  it('refuses a model the Bureau layer denies, and names the layer that denied it', async () => {
    const fixture = await start();
    policy = { bureau: { deniedProviders: ['anthropic'] }, policyRevision: 1 };

    const problem = await problemOf(
      fixture.catalog.create('helper', definitionOf({ model: KNOWN_MODEL })),
    );

    expect(problem.code).toBe('model-policy-denied');
    expect(problem.message).toContain('bureau');
  });

  it('names the deployment layer when both layers deny the model', async () => {
    const fixture = await start();
    policy = {
      deployment: { deniedModels: ['claude-opus-5-5'] },
      bureau: { deniedModels: ['claude-opus-5-5'] },
      policyRevision: 1,
    };

    const problem = await problemOf(
      fixture.catalog.create('helper', definitionOf({ model: KNOWN_MODEL })),
    );

    expect(problem.message).toContain('deployment');
    expect(problem.message).not.toContain('bureau');
  });

  it('saves a model the policy allows, and one when there is no policy at all', async () => {
    const fixture = await start();
    policy = DENY_KNOWN;
    await fixture.catalog.create('allowed', definitionOf({ model: OTHER_MODEL }));
    policy = undefined;
    await fixture.catalog.create('free', definitionOf({ model: KNOWN_MODEL }));

    expect(fixture.catalog.list().map((listing) => [listing.id, listing.state])).toEqual([
      ['allowed', 'ready'],
      ['free', 'ready'],
    ]);
  });

  it('judges a model written as an alias by the row the alias resolves to', async () => {
    const fixture = await start();
    policy = { deployment: { deniedModels: ['claude-sonnet-5'] }, policyRevision: 1 };

    const problem = await problemOf(
      fixture.catalog.create('helper', definitionOf({ model: 'anthropic/sonnet' })),
    );

    expect(problem.code).toBe('model-policy-denied');
    expect(problem.issues?.[0]?.reference).toBe('anthropic/sonnet');
  });

  it('refuses a forbidden entry in models at its index, though the default is allowed', async () => {
    const fixture = await start();
    policy = DENY_KNOWN;

    const problem = await problemOf(
      fixture.catalog.create(
        'helper',
        definitionOf({ model: OTHER_MODEL, models: [OTHER_MODEL, KNOWN_MODEL] }),
      ),
    );

    expect(problem.code).toBe('model-policy-denied');
    expect(problem.issues).toEqual([
      expect.objectContaining({ path: 'models.1', reference: KNOWN_MODEL }),
    ]);
  });

  it('ignores a models entry the catalog does not hold, as it always has', async () => {
    const fixture = await start();
    policy = DENY_KNOWN;

    await fixture.catalog.create(
      'helper',
      definitionOf({ model: OTHER_MODEL, models: [OTHER_MODEL, 'x/y'] }),
    );

    expect(fixture.catalog.list()[0]).toMatchObject({ id: 'helper', state: 'ready' });
  });

  it('refuses a model denied only because its provider is, by the model name', async () => {
    const fixture = await start();
    policy = { deployment: { deniedProviders: ['openai'] }, policyRevision: 1 };

    const problem = await problemOf(
      fixture.catalog.create('helper', definitionOf({ model: 'openai/gpt-4.1' })),
    );

    expect(problem.code).toBe('model-policy-denied');
  });

  it('refuses a definition that is only being tried, and creates no context for it', async () => {
    const fixture = await start();
    policy = DENY_KNOWN;

    const problem = await problemOf(() =>
      fixture.catalog.ephemeral('trial', definitionOf({ model: KNOWN_MODEL })),
    );

    expect(problem.code).toBe('model-policy-denied');
    expect(fixture.catalog.find('trial')).toBeUndefined();
  });
});

describe('a file saved before the policy tightened', () => {
  it('is still listed ready and still yields an agent, because a scan never asks the policy', async () => {
    const fixture = await start();
    await fixture.put('old.md', agentFileText({ name: 'Old', model: KNOWN_MODEL }));
    await fixture.catalog.revalidate();
    policy = DENY_KNOWN;
    await fixture.catalog.revalidate();

    expect(fixture.catalog.list().map((listing) => [listing.id, listing.state])).toEqual([
      ['old', 'ready'],
    ]);
    expect(fixture.catalog.find('old')).toBeDefined();
  });

  it('refuses an edit that keeps the forbidden model, and saves one that changes it', async () => {
    const fixture = await start();
    const { hash } = await fixture.catalog.create('old', definitionOf({ model: KNOWN_MODEL }));
    policy = DENY_KNOWN;

    const problem = await problemOf(
      fixture.catalog.update(
        'old',
        { ...definitionOf({ model: KNOWN_MODEL }), instructions: 'Changed.\n' },
        { expectedHash: hash },
      ),
    );
    expect(problem.code).toBe('model-policy-denied');

    await fixture.catalog.update(
      'old',
      { ...definitionOf({ model: OTHER_MODEL }), instructions: 'Changed.\n' },
      { expectedHash: hash },
    );
    expect(fixture.catalog.list()[0]).toMatchObject({ id: 'old', state: 'ready' });
  });
});

describe('a restore under a model policy', () => {
  it('refuses to restore a version whose model the policy now forbids, and writes nothing', async () => {
    const fixture = await start();
    const created = await fixture.catalog.create('old', definitionOf({ model: KNOWN_MODEL }));
    const updated = await fixture.catalog.update(
      'old',
      { ...definitionOf({ model: OTHER_MODEL }), instructions: 'Changed.\n' },
      { expectedHash: created.hash },
    );
    policy = DENY_KNOWN;

    const problem = await problemOf(
      fixture.catalog.versions.restore('old', 1, { expectedHash: updated.hash }),
    );

    expect(problem.code).toBe('model-policy-denied');
    expect(fixture.catalog.list()[0]?.definitionHash).toBe(updated.hash);
  });
});
