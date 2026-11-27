import { afterEach, describe, expect, it } from 'bun:test';

import { callAs, disposeServed, seed, serve } from './agent-definitions-fixtures.test-support.ts';

afterEach(disposeServed);

describe('bureau.agents.definitions.rename', () => {
  it('changes a saved agent through the normal authorized endpoint', async () => {
    const served = await serve();
    await seed(served);

    const renamed = await callAs(served.local, 'bureau.agents.definitions.rename', {
      id: 'researcher',
      to: 'investigator',
      expectedHash: served.hashOf('researcher'),
    });

    expect(renamed.error).toBeUndefined();
    expect(renamed.result).toMatchObject({
      from: 'researcher',
      to: 'investigator',
      phase: 'cutover',
    });
    expect((await callAs(served.local, 'bureau.agents.definitions.get', { id: 'researcher' })).error)
      .toMatchObject({ data: { weftCode: 'NotFound' } });
    expect((await callAs(served.local, 'bureau.agents.definitions.get', { id: 'investigator' })).result)
      .toMatchObject({ id: 'investigator' });
  });
});
