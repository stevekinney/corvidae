/** @deprecated Import object-store operations from `@lostgradient/object-store`. */
export type {
  ListedObject,
  ListedPage,
  ObjectStoreOperations,
  ObjectWriteCondition,
  S3ObjectStoreOperations,
} from '@lostgradient/object-store';
export { ObjectStoreError, createS3ObjectOperations } from '@lostgradient/object-store';

/** Where an S3 definition source keeps its objects. */
export interface ObjectLocation {
  readonly bucket: string;
  readonly prefix: string;
}
