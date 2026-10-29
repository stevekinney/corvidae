/**
 * Native-transaction batch atomicity for the disk-backed SQLite adapters Weft holds. The suite
 * lives in `@lostgradient/storage/testing`; this file runs it against Weft's specs.
 */
import { describeBatchAtomicitySuite } from '@lostgradient/storage/testing';
import { availableAdapterSpecs } from './sqlite-adapter-specs.test-support.ts';

describeBatchAtomicitySuite(availableAdapterSpecs());
