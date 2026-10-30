/**
 * COR-1865 — `stepLimit` and `retry` over `bureau.agents.definitions.*`: a create writes them, `get`
 * shows them (`null` for a file that sets none), an update that leaves them out keeps the file's
 * values and `null` removes them, and an out-of-range value is refused before anything is written.
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

describe('stepLimit and retry on the definition operations', () => {
  it('creates an agent with both, and shows them on get', async () => {
    const served = await serve();
    const retry = { attempts: 3, delayMilliseconds: 200, jitter: true };
    const created = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'patient',
      definition: { ...DEFINITION, stepLimit: 8, retry },
    });
    expect(created.error).toBeUndefined();

    const text = await readFile(ownerPath(served, 'patient'), 'utf8');
    expect(text).toContain('stepLimit: 8');
    const got = await callAs(served.owner, 'bureau.agents.definitions.get', { id: 'patient' });
    expect(got.result?.['definition']).toMatchObject({ stepLimit: 8, retry });
  });

  it('shows null for a file that sets neither', async () => {
    const served = await serve();
    await seed(served);
    const got = await callAs(served.owner, 'bureau.agents.definitions.get', { id: 'researcher' });
    expect(got.result?.['definition']).toMatchObject({ stepLimit: null, retry: null });
  });

  it('keeps both when an update leaves them out, and removes them for null', async () => {
    const served = await serve();
    await served.put(
      'patient.md',
      `---\nmodel: ${DEFINITION.model}\nstepLimit: 8\nretry: {attempts: 2}\n---\nBody.\n`,
    );
    await served.bureau.agents.refresh();
    const hash = served.hashOf('patient');
    const kept = await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'patient',
      expectedHash: hash,
      definition: { model: DEFINITION.model, name: 'Patient', instructions: 'Body.\n' },
    });
    expect(kept.error).toBeUndefined();
    const afterKeep = await callAs(served.owner, 'bureau.agents.definitions.get', {
      id: 'patient',
    });
    expect(afterKeep.result?.['definition']).toMatchObject({
      name: 'Patient',
      stepLimit: 8,
      retry: { attempts: 2 },
    });

    const cleared = await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'patient',
      expectedHash: kept.result?.['hash'],
      definition: {
        model: DEFINITION.model,
        name: 'Patient',
        instructions: 'Body.\n',
        stepLimit: null,
        retry: null,
      },
    });
    expect(cleared.error).toBeUndefined();
    const text = await readFile(ownerPath(served, 'patient'), 'utf8');
    expect(text).not.toContain('stepLimit');
    expect(text).not.toContain('retry');
  });

  it('refuses an out-of-range value and writes nothing', async () => {
    const served = await serve();
    for (const definition of [
      { ...DEFINITION, stepLimit: 0 },
      { ...DEFINITION, stepLimit: 1001 },
      { ...DEFINITION, retry: { attempts: 11 } },
      { ...DEFINITION, retry: { attempts: 2, delayMilliseconds: 60001 } },
      { ...DEFINITION, retry: { attempts: 2, backoff: 2 } },
    ]) {
      const response = await callAs(served.owner, 'bureau.agents.definitions.create', {
        id: 'strict',
        definition,
      });
      expect([JSON.stringify(definition), response.error?.data?.httpStatus]).toEqual([
        JSON.stringify(definition),
        400,
      ]);
    }
    expect(await Bun.file(ownerPath(served, 'strict')).exists()).toBe(false);
  });
});
