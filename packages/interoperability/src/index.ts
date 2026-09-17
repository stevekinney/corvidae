export type { StandardSchemaV1 } from '@standard-schema/spec';
export { computeEmbeddingVectorMagnitude, cosineSimilarity, isEmbeddingVector } from './embeddings';
export type {
  Embedder,
  EmbeddingVector,
  EmbeddingVectorLike,
  IsEmbeddingVectorOptions,
} from './embeddings';
export {
  createIncrementalHash,
  hmacSha256HexSync,
  sha256Hex,
  sha256HexSync,
  timingSafeEqualHex,
} from './hash';
export type { IncrementalHash } from './hash';
export {
  assertJSONValue,
  isJSONValue,
  materializeToolCall,
  materializeToolCalls,
  materializeToolResult,
  materializeToolResultAsync,
  materializeToolResults,
  materializeToolResultsAsync,
} from './materialization';
export type { MaterializeToolCallOptions, MaterializeToolResultOptions } from './materialization';
export { isStandardSchema, validateStandardSchema } from './standard-schema';
export type {
  JSONArray,
  JSONObject,
  JSONPrimitive,
  JSONValue,
  ToolAction,
  ToolActionInput,
  ToolCall,
  ToolCallInput,
  ToolError,
  ToolErrorCategory,
  ToolErrorInput,
  ToolPolicy,
  ToolResult,
  ToolResultInput,
} from './types';
