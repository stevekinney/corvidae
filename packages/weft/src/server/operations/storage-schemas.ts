import { MAX_BATCH_OPERATIONS, MAX_SCAN_LIMIT } from '@lostgradient/storage';
import { z } from 'zod';

const binaryValueSchema: z.ZodType<Uint8Array, Uint8Array> = z
  .instanceof(Uint8Array)
  .meta({ type: 'string', format: 'binary' });

const storageKeyInput = z.string().min(1);

export const storageGetInput = z.object({
  key: storageKeyInput.describe('Key of the raw storage value to read.'),
});

export const storagePutInput = z.object({
  key: storageKeyInput.describe('Key to write the value under.'),
  value: binaryValueSchema.describe('Value bytes to store, replacing any existing value.'),
});

export const storageDeleteInput = z.object({
  key: storageKeyInput.describe('Key of the raw storage value to delete.'),
});

export const storageScanInput = z.object({
  prefix: z.string().describe('Return only entries whose key starts with this prefix.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_SCAN_LIMIT)
    .optional()
    .describe('Maximum number of entries to return.'),
  reverse: z
    .boolean()
    .optional()
    .describe('When true, return entries in descending key order instead of ascending.'),
  gt: z.string().optional().describe('Return only keys strictly greater than this key.'),
  gte: z.string().optional().describe('Return only keys greater than or equal to this key.'),
  lt: z.string().optional().describe('Return only keys strictly less than this key.'),
  lte: z.string().optional().describe('Return only keys less than or equal to this key.'),
});

const storageBatchOperationInput = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('put').describe('Write a value.'),
    key: storageKeyInput.describe('Key to write.'),
    value: z.string().describe('Value to store, base64-encoded.'),
  }),
  z.object({
    type: z.literal('delete').describe('Delete a value.'),
    key: storageKeyInput.describe('Key to delete.'),
  }),
]);

const storageConditionInput = z.object({
  key: storageKeyInput.describe('Key whose current value is checked.'),
  expectedValue: z
    .string()
    .nullable()
    .describe('Base64-encoded value the key must currently hold, or null if it must be absent.'),
});

export const storageBatchInput = z.object({
  operations: z
    .array(storageBatchOperationInput)
    .max(MAX_BATCH_OPERATIONS)
    .describe('Puts and deletes to apply together as one atomic batch.'),
});

export const storageConditionalBatchInput = z.object({
  conditions: z
    .array(storageConditionInput)
    .max(MAX_BATCH_OPERATIONS)
    .describe('Key checks that must all hold for the batch to be applied.'),
  operations: z
    .array(storageBatchOperationInput)
    .max(MAX_BATCH_OPERATIONS)
    .describe('Puts and deletes to apply, only if every condition holds.'),
});

export const emptyOutput = z.null();
export const storageGetOutput = binaryValueSchema.nullable();
export const storageScanOutput = z.custom<StorageScanOutput>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function',
  'Storage scan output must be an async iterable.',
);
export const storageConditionalBatchOutput = z.object({ applied: z.boolean() });

export type StorageGetInput = z.infer<typeof storageGetInput>;
export type StoragePutInput = z.infer<typeof storagePutInput>;
export type StorageDeleteInput = z.infer<typeof storageDeleteInput>;
export type StorageScanInput = z.infer<typeof storageScanInput>;
type StorageScanEntry = { readonly key: string; readonly value: string };
export type StorageScanOutput = AsyncIterable<StorageScanEntry>;
export type StorageBatchInput = z.infer<typeof storageBatchInput>;
export type StorageConditionalBatchInput = z.infer<typeof storageConditionalBatchInput>;
export type StorageConditionalBatchOutput = z.infer<typeof storageConditionalBatchOutput>;
