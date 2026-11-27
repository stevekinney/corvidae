# `@lostgradient/object-store`

The shared contract lists objects, reads bytes with their opaque quoted ETag, and performs conditional writes. An `absent` write succeeds only once; an `etag` write succeeds only when that ETag is current. A stale condition leaves stored bytes unchanged.

`createS3ObjectOperations` signs S3-compatible `fetch` requests and additionally exposes conditional `remove`: a stale ETag preserves the object and a matching ETag removes it. `createR2ObjectOperations` exposes only the shared operations. It deliberately has no delete method and never approximates conditional delete with a read followed by delete. Conditional R2 writes are verified against a local Miniflare R2 binding.
