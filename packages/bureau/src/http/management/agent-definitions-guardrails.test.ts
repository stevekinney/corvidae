/**
 * COR-1912 — `guardrails` over `bureau.agents.definitions.*`: a create writes it, `get` shows it
 * (`null` for a file that names none), an update that leaves it out keeps the file's value and
 * `null` removes it, and a name that is not a preset is refused before anything is written.
 */
import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  callAs,
  DEFINITION,
  disposeServed,
  ownerPath,
  seed,
  serve,
} from './agent-definitions-fixtures.test-support.ts';

afterEach(disposeServed);

describe('guardrails on the definition operations', () => {
  it('creates an agent with each preset, and shows it on get', async () => {
    const served = await serve();
    for (const preset of ['default', 'tripwire', 'off'] as const) {
      const id = `guarded-${preset}`;
      const created = await callAs(served.owner, 'bureau.agents.definitions.create', {
        id,
        definition: { ...DEFINITION, guardrails: preset },
      });
      expect(created.error).toBeUndefined();

      const text = await readFile(ownerPath(served, id), 'utf8');
      expect(text).toMatch(new RegExp(`guardrails: '?${preset}'?`));
      const got = await callAs(served.owner, 'bureau.agents.definitions.get', { id });
      expect(got.result?.['definition']).toMatchObject({ guardrails: preset });
    }
  });

  it('shows null for a file that names none', async () => {
    const served = await serve();
    await seed(served);
    const got = await callAs(served.owner, 'bureau.agents.definitions.get', { id: 'researcher' });
    expect(got.result?.['definition']).toMatchObject({ guardrails: null });
  });

  it('keeps the preset when an update leaves it out, and removes it for null', async () => {
    const served = await serve();
    await served.put(
      'patient.md',
      `---\nmodel: ${DEFINITION.model}\nguardrails: tripwire\n---\nBody.\n`,
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
    expect(afterKeep.result?.['definition']).toMatchObject({
      name: 'Patient',
      guardrails: 'tripwire',
    });

    const changed = await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'patient',
      expectedHash: kept.result?.['hash'],
      definition: {
        model: DEFINITION.model,
        name: 'Patient',
        instructions: 'Body.\n',
        guardrails: 'default',
      },
    });
    expect(changed.error).toBeUndefined();
    expect(await readFile(ownerPath(served, 'patient'), 'utf8')).toContain('guardrails: default');

    const cleared = await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'patient',
      expectedHash: changed.result?.['hash'],
      definition: {
        model: DEFINITION.model,
        name: 'Patient',
        instructions: 'Body.\n',
        guardrails: null,
      },
    });
    expect(cleared.error).toBeUndefined();
    expect(await readFile(ownerPath(served, 'patient'), 'utf8')).not.toContain('guardrails');
  });

  it('refuses a name that is not a preset and writes nothing', async () => {
    const served = await serve();
    for (const guardrails of ['strict', 'Default', true, ['default']]) {
      const response = await callAs(served.owner, 'bureau.agents.definitions.create', {
        id: 'strict',
        definition: { ...DEFINITION, guardrails },
      });
      expect([JSON.stringify(guardrails), response.error?.data?.httpStatus]).toEqual([
        JSON.stringify(guardrails),
        400,
      ]);
    }
    expect(await Bun.file(ownerPath(served, 'strict')).exists()).toBe(false);
  });
});
