import { CompressedStorage, MemoryStorage } from '@lostgradient/weft';

// @ts-expect-error Agent-specific compression options are intentionally not public API.
declare const _removedAgentCompressionOptions: import('@lostgradient/weft').AgentCompressionOptions;
void _removedAgentCompressionOptions;

const _storage = new CompressedStorage(new MemoryStorage(), {
  algorithm: 'gzip',
  threshold: 1024,
});
void _storage;
