import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { shellProfile } from '../bun/fixtures/bun-pipe-stdin.ts';
import { CORPUS } from '../protocol/corpus/fixtures.ts';
import {
  bytesOn,
  channelFor,
  conclude,
  exitsIn,
  type CaseDefinition,
} from './conformance-cases.test-support.ts';
import { check } from './conformance.test-support.ts';

/**
 * The shared byte corpus, delivered by a real process that writes each fixture's bytes unchanged.
 * A PTY's output processing is turned off first, so nothing between the process and the consumer
 * rewrites a byte; every fixture must then arrive exactly, whichever way it travelled.
 */
export const CORPUS_CASES: readonly CaseDefinition[] = CORPUS.map((fixture) => ({
  id: `corpus-${fixture.id}`,
  modes: ['pipe', 'pty'],
  launch(mode, scratch) {
    const file = join(scratch, `${mode}-${fixture.id}.bin`);
    writeFileSync(file, fixture.bytes);
    return { profile: shellProfile(`${mode === 'pty' ? 'stty -opost; ' : ''}cat "$1"`, [file]) };
  },
  async run({ rig, mode }) {
    await rig.client.handshake();
    await rig.client.waitForKind('process-exit');
    const { cleanup, closeCode } = await conclude(rig);
    const received = bytesOn(rig.client.messages, channelFor(mode));
    return [
      check(
        `${fixture.bytes.length} bytes arrived exactly, none added, altered or reordered`,
        Buffer.compare(received, fixture.bytes) === 0,
      ),
      check(
        'the process exited cleanly after the last byte',
        exitsIn(rig).length === 1 && exitsIn(rig).every((exit) => exit.exitCode === 0),
      ),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the transport closed normally', closeCode === 1000),
    ];
  },
}));
