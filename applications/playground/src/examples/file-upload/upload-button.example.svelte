<script lang="ts" module>
  export const title = 'Upload button with a summary';
  export const description =
    'variant="button" is only a secondary button and a line of text beside it, for one file whose details the page already shows. It draws no rows; read the chosen file through onFilesChange.';
</script>

<script lang="ts">
  import { FileUpload, type FileUploadEntry } from '@lostgradient/cinder';

  const uid = $props.id();
  let summary = $state('payments-openapi.yaml · OpenAPI 3.1 · 24 operations');

  function handleFilesChange(entries: FileUploadEntry[]) {
    const entry = entries.find((candidate) => candidate.rejectionReason === undefined);
    if (entry) summary = entry.file.name;
  }
</script>

<FileUpload
  id={`${uid}-spec`}
  variant="button"
  accept=".yaml,.yml,.json"
  browseLabel="Upload a file"
  {summary}
  onFilesChange={handleFilesChange}
/>
