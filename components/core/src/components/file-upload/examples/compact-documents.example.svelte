<script lang="ts" module>
  export const title = 'Reference documents, uploading and too large';
  export const description =
    'variant="compact" is a short list on a form: settled files are one bordered list (name, size, remove), an arriving file is one line (name, bar, percent, Cancel upload), and the one-line zone stays below. A file over the limit is a danger alert between the list and the zone that names the file and says nothing was added; the next file chosen clears it.';
</script>

<script lang="ts">
  import {
    FileUpload,
    FormSection,
    type FileUploadEntry,
    type FileUploadRejection,
  } from '@lostgradient/cinder';

  const megabyte = 1024 * 1024;
  const uid = $props.id();

  function sampleFile(name: string, size: number): File {
    const file = new File(['x'], name);
    Object.defineProperty(file, 'size', { value: size });
    return file;
  }

  let files = $state<FileUploadEntry[]>([
    {
      id: 'refund-policy',
      file: sampleFile('Refund policy.md', 4 * 1024),
      status: 'ready',
    },
    {
      id: 'returns-policy',
      file: sampleFile('Returns policy.pdf', megabyte),
      status: 'uploading',
      progress: 60,
    },
  ]);

  function describeRejection({ file, maxSize = 0 }: FileUploadRejection): string {
    const size = `${Math.round(file.size / megabyte)} MB`;
    return `${file.name} is ${size}; documents can be up to ${maxSize / megabyte} MB. Nothing was added.`;
  }
</script>

<FormSection heading="Reference documents" meta="Read with every chat" columns={1}>
  <FileUpload
    id={`${uid}-documents`}
    variant="compact"
    multiple
    accept=".pdf,.md,.txt"
    maxSize={5 * megabyte}
    browseLabel="Add a document"
    description="or drop files here, PDF, Markdown or text, up to 5 MB each"
    rejectionMessage={describeRejection}
    {files}
    onFilesChange={(next) => (files = next)}
    onFileCancel={(entry) => (files = files.filter((candidate) => candidate.id !== entry.id))}
  />
</FormSection>
