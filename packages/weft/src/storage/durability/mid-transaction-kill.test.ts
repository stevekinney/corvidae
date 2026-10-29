/**
 * Mid-transaction SIGKILL scenarios for the disk-backed SQLite adapters Weft holds. The suite lives
 * in `@lostgradient/storage/testing`; this file runs it against Weft's specs.
 */
import { runMidTransactionKillSuite } from '@lostgradient/storage/testing';
import {
  availableAdapterSpecs,
  availableBunNodeAdapterSpecs,
} from './sqlite-adapter-specs.test-support.ts';

await runMidTransactionKillSuite(availableAdapterSpecs(), availableBunNodeAdapterSpecs());
