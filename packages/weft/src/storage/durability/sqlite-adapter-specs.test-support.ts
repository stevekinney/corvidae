/**
 * The durability suites' specs for the disk-backed adapters Weft still holds: Turso, whose spec
 * lives in `turso-adapter-spec.test-support.ts`. The Bun SQLite and Node SQLite adapters'
 * specs live in their own packages. The suites and their adapter-independent support live in
 * `@lostgradient/storage/testing`; each spec carries its adapter and the module its child
 * entrypoints import.
 */

import type { AdapterSpec, RawHandleAdapterSpec } from '@lostgradient/storage/testing';
import { tursoSpec } from './turso-adapter-spec.test-support.ts';

/** All adapter specs available in the current runtime. */
export function availableAdapterSpecs(): readonly AdapterSpec[] {
  return [tursoSpec];
}

/** The specs with a raw same-file handle, for tests that need a raw client path; none remain. */
export function availableRawHandleAdapterSpecs(): readonly RawHandleAdapterSpec[] {
  return [];
}
