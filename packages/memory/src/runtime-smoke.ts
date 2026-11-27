import { chunkText } from './index.ts';

/** Exercises portable memory text chunking. Filesystem synchronization stays Node-only. */
export function runRuntimeSmoke(): void {
  if (chunkText({ text: 'portable memory' }).length === 0) {
    throw new Error('Memory chunking produced no chunks.');
  }
}
