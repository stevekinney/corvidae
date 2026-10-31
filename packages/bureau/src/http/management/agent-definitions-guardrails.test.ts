/**
 * COR-1877 — `guardrails` and `hooks` over `bureau.agents.definitions.*`: a create writes the ids,
 * `get` shows them (`null` for a file that lists none), an update that leaves one out keeps the
 * file's list and `null` removes it, an id no plugin contributes is refused as
 * `reference-unresolved` before anything is written, and the old preset name is refused as a
 * malformed value.
 */
import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'bun:test';

import { createAgentContributions } from '../../agent-contributions.ts';
import {
  callAs,
  DEFINITION,
  disposeServed,
  ownerPath,
  seed,
  serve,
} from './agent-definitions-fixtures.test-support.ts';

afterEach(disposeServed);

const contributions = createAgentContributions([
  {
    plugin: 'x',
    guardrails: {
      inputDetectors: [
        {
          name: 'check',
          detect: async () => ({ triggered: false, category: 'policy', confidence: 0 }),
        },
      ],
    },
    runHooks: [{ name: 'audit' }],
  },
]);

function servedWithContributions() {
  return serve({ overrides: { agentContributions: contributions } });
}

describe.each(['guardrails', 'hooks'] as const)('%s on the definition operations', (key) => {
  const id = key === 'guardrails' ? 'x:check' : 'x:audit';

  it('creates an agent that lists an id, and shows it on get', async () => {
    const served = await servedWithContributions();
    const created = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'guarded',
      definition: { ...DEFINITION, [key]: [id] },
    });
    expect(created.error).toBeUndefined();

    expect(await readFile(ownerPath(served, 'guarded'), 'utf8')).toContain(id);
    const got = await callAs(served.owner, 'bureau.agents.definitions.get', { id: 'guarded' });
    expect(got.result?.['definition']).toMatchObject({ [key]: [id] });
  });

  it('shows null for a file that lists none', async () => {
    const served = await servedWithContributions();
    await seed(served);
    const got = await callAs(served.owner, 'bureau.agents.definitions.get', { id: 'researcher' });
    expect(got.result?.['definition']).toMatchObject({ [key]: null });
  });

  it('keeps the list when an update leaves it out, and removes it for null', async () => {
    const served = await servedWithContributions();
    await served.put(
      'patient.md',
      `---\nmodel: ${DEFINITION.model}\n${key}: [${id}]\n---\nBody.\n`,
    );
    await served.bureau.agents.refresh();
    const kept = await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'patient',
      expectedHash: served.hashOf('patient'),
      definition: { model: DEFINITION.model, name: 'Patient', instructions: 'Body.\n' },
    });
    expect(kept.error).toBeUndefined();
    const afterKeep = await callAs(served.owner, 'bureau.agents.definitions.get', {
      id: 'patient',
    });
    expect(afterKeep.result?.['definition']).toMatchObject({ name: 'Patient', [key]: [id] });

    const cleared = await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'patient',
      expectedHash: kept.result?.['hash'],
      definition: {
        model: DEFINITION.model,
        name: 'Patient',
        instructions: 'Body.\n',
        [key]: null,
      },
    });
    expect(cleared.error).toBeUndefined();
    expect(await readFile(ownerPath(served, 'patient'), 'utf8')).not.toContain(key);
  });

  it('refuses an id no plugin contributes as reference-unresolved, and writes nothing', async () => {
    const served = await servedWithContributions();
    const response = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'unresolved',
      definition: { ...DEFINITION, [key]: ['y:gone'] },
    });
    expect(response.error?.data?.['reason']).toBe('reference-unresolved');
    expect(await Bun.file(ownerPath(served, 'unresolved')).exists()).toBe(false);
  });

  it('refuses a value that is not a list of ids, the old preset names among them', async () => {
    const served = await servedWithContributions();
    for (const value of ['tripwire', 'off', true, [1], ['']]) {
      const response = await callAs(served.owner, 'bureau.agents.definitions.create', {
        id: 'strict',
        definition: { ...DEFINITION, [key]: value },
      });
      expect([JSON.stringify(value), response.error?.data?.httpStatus]).toEqual([
        JSON.stringify(value),
        400,
      ]);
    }
    expect(await Bun.file(ownerPath(served, 'strict')).exists()).toBe(false);
  });
});
