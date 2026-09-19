# Embeddings

`@corvidae/embeddings` owns the shared embedding function contract, vector types, boundary validation, and similarity mathematics used by Armorer, Memory, and Operative.

## Public API

- `Embedder`, `EmbeddingVector`, and `EmbeddingVectorLike` describe embedding providers and their vectors.
- `isEmbeddingVector` validates unknown arrays and typed arrays at trust boundaries.
- `computeEmbeddingVectorMagnitude` computes the Euclidean norm of a vector.
- `cosineSimilarity` compares equal-length finite vectors.

The package is independent of tool protocols, storage, and provider SDKs. Consumers own those integrations.

## Development

Run `bunx turbo run lint typecheck test --filter=@corvidae/embeddings --concurrency=1` from the repository root. Run `bun run validate` for the complete workspace.
