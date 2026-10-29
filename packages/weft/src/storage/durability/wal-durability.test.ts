/**
 * WAL-mode on-disk durability for the disk-backed SQLite adapters Weft holds. The suite lives in
 * `@lostgradient/storage/testing`; this file runs it against Weft's specs.
 */
import { describeWalDurabilitySuite } from '@lostgradient/storage/testing';
import { availableAdapterSpecs } from './sqlite-adapter-specs.test-support.ts';

describeWalDurabilitySuite(availableAdapterSpecs());
