import {
  createS3ObjectOperations,
  type ObjectPresigner,
  type ObjectStoreOperations,
  type S3ObjectStoreOperations,
} from '@lostgradient/object-store';

/** The portable object-store operations Bungalow exposes in remote mode. */
export type BungalowObjectStore = ObjectStoreOperations;

/** The remote S3 operations Bungalow keeps while it establishes its own state. */
type RemoteObjectStore = S3ObjectStoreOperations & { readonly presign: ObjectPresigner };

/** Build Bungalow's S3 operations. Every request is sent through the shared object-store package. */
export function createObjectStore(
  presign: ObjectPresigner,
  bucket: string,
  contentType = 'application/octet-stream',
): RemoteObjectStore {
  return { ...createS3ObjectOperations({ presigner: presign, bucket, contentType }), presign };
}
