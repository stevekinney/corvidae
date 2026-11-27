import {
  createS3ObjectOperations,
  type ObjectPresigner,
  type S3ObjectStoreOperations,
} from '@lostgradient/object-store';

/** The remote S3 operations Bungalow exposes, plus its private signing probe used while opening. */
export type BungalowObjectStore = S3ObjectStoreOperations & { readonly presign: ObjectPresigner };

/** Build Bungalow's S3 operations. Every request is sent through the shared object-store package. */
export function createObjectStore(
  presign: ObjectPresigner,
  bucket: string,
  contentType = 'application/octet-stream',
): BungalowObjectStore {
  return { ...createS3ObjectOperations({ presigner: presign, bucket, contentType }), presign };
}
