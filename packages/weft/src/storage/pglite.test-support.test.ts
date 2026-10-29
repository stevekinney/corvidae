import { describe, expect, it } from 'bun:test';

import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { createPGliteTestFixture } from './pglite.test-support.ts';

// This fixture stays in Weft only for `neon.test.ts` until Neon moves into its own package
// (COR-1775), which deletes both the fixture and this test. The Postgres adapter's package runs
// the same case against its own copy.
describe('createPGliteTestFixture', () => {
  it('rejects PGlite fixture access outside its registered lifecycle', async () => {
    let initialize: (() => void | Promise<void>) | undefined;
    let dispose: (() => void | Promise<void>) | undefined;
    const fixture = createPGliteTestFixture({
      beforeAll(callback) {
        initialize = callback;
      },
      afterAll(callback) {
        dispose = callback;
      },
    });

    expect(() => fixture.database).toThrow('PGlite test fixture is not running');
    expect(await throwingRejectionOf(fixture.reset())).toThrow(
      'PGlite test fixture is not running',
    );

    await initialize?.();
    expect(fixture.database).toBeDefined();
    await fixture.reset();
    const poolResult = await fixture.pool.query('SELECT 1');
    expect(poolResult.rows).toHaveLength(1);
    const client = await fixture.pool.connect();
    const clientResult = await client.query('SELECT 1');
    expect(clientResult.rows).toHaveLength(1);
    client.release();
    await fixture.pool.end();

    await dispose?.();
    expect(() => fixture.database).toThrow('PGlite test fixture is not running');
    expect(await throwingRejectionOf(fixture.reset())).toThrow(
      'PGlite test fixture is not running',
    );
  });
});
