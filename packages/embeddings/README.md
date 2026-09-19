# Embeddings

`@corvidae/embeddings` owns the shared embedding function contract, vector types, boundary validation, and similarity mathematics used by Armorer, Memory, and Operative.

## Public API

- `Embedder`, `EmbeddingVector`, and `EmbeddingVectorLike` describe embedding providers and their vectors.
- `isEmbeddingVector` validates unknown arrays and typed arrays at trust boundaries.
- `computeEmbeddingVectorMagnitude` computes the Euclidean norm of a vector.
- `cosineSimilarity` compares equal-length finite vectors.

The package is independent of tool protocols, storage, and provider SDKs. Consumers own those integrations.

## Comparing vectors

An embedding represents text as a vector: an ordered list of numbers. Similarity is meaningful only when both vectors come from the same model and have the same dimensions. This package handles the numbers; the calling package owns model selection and the text-to-vector request.

Validate provider output before using it. The dimension check catches a changed model or malformed response before it reaches storage:

```typescript
import { cosineSimilarity, isEmbeddingVector } from '@corvidae/embeddings';

const candidate: unknown = new Float32Array([1, 0, 0]);
if (!isEmbeddingVector(candidate, { dimension: 3 })) {
  throw new TypeError('Expected a finite three-dimensional embedding');
}

const score = cosineSimilarity(candidate, [0, 1, 0]);
console.log(score); // 0: the vectors are perpendicular.
```

`isEmbeddingVector` accepts arrays and numeric typed arrays, rejects `NaN`, infinity, sparse entries, `DataView`, and arbitrary objects with a `length` property, and rejects empty vectors unless `allowEmpty: true` is supplied. `EmbeddingVectorLike` is a read-only input contract; the guard does not copy or freeze its input.

`cosineSimilarity` returns `0` for equal-length empty vectors or a zero-magnitude vector. Different lengths throw `RangeError`; non-finite entries throw `TypeError`. `computeEmbeddingVectorMagnitude` assumes validated finite entries and returns `0` for an empty vector. Similarity is a ranking value, not a probability or a model-independent confidence score.

## Workspace usage

Declare `"@corvidae/embeddings": "workspace:*"` in the consuming workspace. Import from the package root; consumers compile the private TypeScript source directly. See [Memory](../memory/README.md) for storage and retrieval and [Armorer](../armorer/README.md) for tool discovery.

## Development

Run `bunx turbo run lint typecheck test --filter=@corvidae/embeddings --concurrency=1` from the repository root. Run `bun run validate` for the complete workspace.
