/**
 * WAL-mode on-disk durability for `TursoStorage`. The suite lives in
 * `@lostgradient/storage/testing`; this file runs it against the Turso spec.
 */
import { describeWalDurabilitySuite } from '@lostgradient/storage/testing';
import { tursoSpec } from './turso-spec.test-support.ts';

describeWalDurabilitySuite([tursoSpec]);
