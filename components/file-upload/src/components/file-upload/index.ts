import './file-upload.css';
import FileUpload from './file-upload.svelte';

export default FileUpload;
export type {
  FileUploadEntry,
  FileUploadProps,
  FileUploadRejection,
  FileUploadRejectionReason,
  FileUploadStatus,
  FileUploadVariant,
  RejectedFile,
} from './file-upload.types.ts';
export { FileUpload };
