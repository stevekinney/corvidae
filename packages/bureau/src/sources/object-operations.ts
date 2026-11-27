/** Where an S3 definition source keeps its objects. */
export interface ObjectLocation {
  readonly bucket: string;
  readonly prefix: string;
}
