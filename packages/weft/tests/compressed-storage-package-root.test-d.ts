import { CompressedStorage, MemoryStorage } from '@repo/weft';

// @ts-expect-error Agent-specific compression options are intentionally not public API.
declare const _removedAgentCompressionOptions: import('@repo/weft').AgentCompressionOptions;
void _removedAgentCompressionOptions;

const _storage = new CompressedStorage(new MemoryStorage(), {
  algorithm: 'gzip',
  threshold: 1024,
});
void _storage;
