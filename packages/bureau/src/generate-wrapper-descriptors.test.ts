import {
  createModelCatalog,
  type GenerateFunction,
  readBackendDescriptors,
  withBackendDescriptors,
} from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { withUsageTracking } from './runtime-composition';

/**
 * COR-716 — a wrapper around a `GenerateFunction` reports the backends it can
 * reach. Without the descriptors, admission has nothing to cost media against
 * and refuses every part as `no-estimator`.
 */
describe('Bureau generate wrappers keep the inner backend descriptors', () => {
  it('withUsageTracking re-attaches the routing generate’s descriptors', () => {
    const descriptors = createModelCatalog().descriptors.filter(
      (descriptor) => descriptor.provider === 'anthropic',
    );
    const inner: GenerateFunction = withBackendDescriptors(
      async () => ({ content: 'ok', toolCalls: [] }),
      descriptors,
    );
    const tracked = withUsageTracking(inner, () => {});
    expect(readBackendDescriptors(tracked)).toEqual(readBackendDescriptors(inner));
  });
});
