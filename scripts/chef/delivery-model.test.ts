import { expect, test } from 'bun:test';

import { validateJUnitArtifacts } from './ci-evidence-workflow.ts';
import { validateDeliveryMergeObservation } from './delivery-verification.ts';

const sha = (character: string) => character.repeat(40);

test('rejects wrong candidate identity and empty test success with contract-owned boundary validators', () => {
  const request = { revision: sha('a'), base: sha('b'), integrationTree: sha('c') };
  expect(() =>
    validateDeliveryMergeObservation(
      {
        route: 'pull-request',
        reviewedHead: sha('d'),
        base: request.base,
        integrationTree: request.integrationTree,
        state: 'pending-provider-outcome',
      },
      request,
    ),
  ).toThrow('does not match the original request identity');

  expect(() =>
    validateJUnitArtifacts({ root: [new TextEncoder().encode('<testsuite/>')] }, ['root']),
  ).toThrow('has an empty report');
});
