<script lang="ts">
  import FileUpload from './file-upload.svelte';
  import type { FileUploadEntry, FileUploadProps } from './file-upload.types.ts';

  let { files: initial = [], ...rest }: FileUploadProps & { files?: FileUploadEntry[] } = $props();

  // svelte-ignore state_referenced_locally
  let files = $state<FileUploadEntry[]>(initial);
</script>

<FileUpload {...rest} {files} onFilesChange={(next) => (files = next)} />
