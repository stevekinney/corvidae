/**
 * Native-transaction batch atomicity for `TursoStorage`. The suite lives in
 * `@lostgradient/storage/testing`; this file runs it against the Turso spec.
 */
import { describeBatchAtomicitySuite } from '@lostgradient/storage/testing';
import { tursoSpec } from './turso-spec.test-support.ts';

describeBatchAtomicitySuite([tursoSpec]);
