/**
 * Mid-transaction SIGKILL scenarios for `TursoStorage`. The suite lives in
 * `@lostgradient/storage/testing`; this file runs it against the Turso spec.
 */
import { runMidTransactionKillSuite } from '@lostgradient/storage/testing';
import { tursoSpec } from './turso-spec.test-support.ts';

await runMidTransactionKillSuite([tursoSpec], []);
