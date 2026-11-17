# FileUpload

Accessible file picker and drag-and-drop surface that validates dropped files, announces results, and can render consumer-driven upload progress rows.

## Usage

```svelte
<script lang="ts">
  import { FileUpload } from '@lostgradient/cinder';
  import type { FileUploadEntry } from '@lostgradient/cinder';
  import { FormField } from '@lostgradient/cinder';

  let entries = $state<FileUploadEntry[]>([]);
  let uploadQueue = $state<File[]>([]);

  function queueFiles(acceptedFiles: File[]) {
    uploadQueue.push(...acceptedFiles);
  }
</script>

<FormField id="resume" label="Resume" description="PDF up to 5 MB">
  <FileUpload
    id="resume"
    accept=".pdf"
    maxSize={5 * 1024 * 1024}
    onFilesAccepted={queueFiles}
    onFilesChange={(nextEntries) => (entries = nextEntries)}
    files={entries}
  />
</FormField>
```

Use `browseLabel` when the picker action needs more specific text, such as directory or import flows. Native input attributes still pass through to the real file input, so directory selection can use `webkitdirectory`:

```svelte
<FileUpload id="history" browseLabel="Choose directory" multiple webkitdirectory />
```

## Upload queue and retry

`FileUpload` owns local validation, not network upload. Each picker selection or drop is validated as one batch before callbacks run:

- `onFilesAccepted` receives the accepted native `File[]` so you can enqueue uploads.
- `onReject` receives rejected files with `too-large`, `wrong-type`, or `too-many` reasons.
- `onFilesChange` receives the full locally resolved queue. Accepted rows start as `pending`; rejected rows start as `error` with a visible message and `rejectionReason`.

The default file list includes a remove button for every row. In uncontrolled use, removing a row immediately updates the local queue and frees a `maxFiles` slot. In controlled use, removal reports the next queue through `onFilesChange`; update `files` with that value to reflect the change. Resetting an associated native form clears the uncontrolled queue and reports an empty list through `onFilesChange`.

Pass the controlled `files` prop to show your uploader's current `pending`, `uploading`, `ready`, or `error` state. Set `progress` from 0–100 while an entry uploads. When you provide `onFileRetry`, failed rows render a retry button and return the complete entry to your upload queue handler. The component never starts, cancels, or retries a network request by itself.

## Variants

`variant` chooses how the surface is drawn; validation, callbacks and the controlled `files` queue behave the same in each.

- `dropzone` (the default) is the large dashed area with a title, a description and a Browse button, with the file rows below it.
- `compact` is for a short list on a form (reference documents on an agent). The settled files are one bordered list of rows (name, size, remove), an arriving file is one line (name, a progress bar, its percent, and a text Cancel upload button), and the zone is one dashed line (a secondary button and one line of help) that stays below the list. Set `browseLabel` to the button's words and `description` to the line beside it.
- `button` is only the secondary button, with an upload glyph, and a line of text beside it (`summary`, usually what was uploaded). It draws no rows; read the file through `onFilesChange`.

Cancel upload is drawn on an uploading row in the compact variant when you pass `onFileCancel`. The component never stops a network request: stop the upload and drop the entry from `files`.

In the compact and button variants a file that fails local validation is a danger alert between the list and the zone, not a row, and it is announced as an alert. The alert says what the last attempt did not add, so choosing the next file clears it (in controlled use, the queue `onFilesChange` reports no longer holds it). Word it with `rejectionMessage`, which receives the file, the reason and the limits:

```svelte
<FileUpload
  id="documents"
  variant="compact"
  multiple
  maxSize={5 * 1024 * 1024}
  browseLabel="Add a document"
  description="or drop files here, PDF, Markdown or text, up to 5 MB each"
  rejectionMessage={({ file }) =>
    `${file.name} is too large; documents can be up to 5 MB. Nothing was added.`}
  {files}
  onFilesChange={(next) => (files = next)}
/>
```

The default dropzone keeps a rejection as a row that names the file. File sizes read as `4 KB` and `12 MB`: a whole unit prints without a decimal.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `accept` | `string` | no | — | Native file accept filter. |
| `borderBeamVisible` | `boolean` | no | `true` | Adds focus and drag-active border emphasis to the dropzone. |
| `browseLabel` | `string` | no | `"Browse files"` | Visible text for the browse button. |
| `cancelLabel` | `string` | no | `"Cancel upload"` | Visible text of the cancel action on an uploading file. Only drawn when `onFileCancel` is set. |
| `class` | `string` | no | — | Additional classes merged with `.cinder-file-upload`. |
| `description` | `string` | no | — | Visible description below the title. Defaults to a summary derived from `accept`. |
| `disabled` | `boolean` | no | — | Disables the file picker and drag-and-drop surface. |
| `draggingLabel` | `string` | no | `"Drop to add"` | Visible label shown while files are dragged over the dropzone. |
| `id` | `string` | no | — | Stable id for the native file input. Required when composing with `FormField`. |
| `maxFiles` | `number` | no | — | Maximum number of files allowed. Files beyond this limit are rejected. |
| `maxSize` | `number` | no | — | Maximum allowed file size in bytes. |
| `multiple` | `boolean` | no | — | Allow more than one file. Default `false`. |
| `name` | `string` | no | — | Native input name used for form submission. |
| `summary` | `string` | no | — | The line of text beside the button in the `'button'` variant, usually what was uploaded, such as the file name and what was read from it. Falls back to `description`. |
| `title` | `string` | no | `"Click to upload or drop files"` | Visible title for the dropzone. |
| `variant` | `"dropzone"` \| `"compact"` \| `"button"` | no | `"dropzone"` | How the surface is drawn. - `'dropzone'` is the large dashed area with a title, a description and a Browse button, the file rows below it. - `'compact'` is a one-line dashed zone (a secondary button and one line of text) that sits under the file rows, for a short list on a form. The rows are one bordered list (name, size, remove), an uploading file is one line (name, bar, percent, Cancel upload), and a file that fails local validation is a danger alert between the rows and the zone saying nothing was added, not a row. The alert stays until the next file is chosen. - `'button'` is just the secondary button and a line of text beside it (`summary`), for one file whose details the page already shows. It draws no rows; read the files through `onFilesChange`. A rejection is still an alert. |
| `dragActive` | `(opaque)` | no | — | Replaces the default drag-active dropzone body. Not expressible in JSON Schema; see the component types for the signature. |
| `fileList` | `(opaque)` | no | — | Replaces the default file-list renderer. Receives the live resolved rows, including an empty array, and a removal callback when the queue is mutable. Not expressible in JSON Schema; see the component types for the signature. |
| `files` | `(opaque)` | no | — | Consumer-driven file rows, including upload progress and error states. Not expressible in JSON Schema; see the component types for the signature. |
| `idle` | `(opaque)` | no | — | Replaces the default resting-state dropzone body. Not expressible in JSON Schema; see the component types for the signature. |
| `onFileCancel` | `(opaque)` | no | — | Called when Cancel upload is activated on an uploading file. The component does not remove the row itself: stop the upload and drop the entry from `files`. Without it an uploading file has no cancel action. Not expressible in JSON Schema; see the component types for the signature. |
| `onFileRetry` | `(opaque)` | no | — | Called when the retry button is activated for a failed file. Not expressible in JSON Schema; see the component types for the signature. |
| `onFilesAccepted` | `(opaque)` | no | — | Fires with accepted files after local validation passes. Not expressible in JSON Schema; see the component types for the signature. |
| `onFilesChange` | `(opaque)` | no | — | Fires with the full resolved entry list after local validation changes it. Not expressible in JSON Schema; see the component types for the signature. |
| `onReject` | `(opaque)` | no | — | Fires with rejected files and reasons after local validation runs. Not expressible in JSON Schema; see the component types for the signature. |
| `rejectionMessage` | `(opaque)` | no | — | Words for a local validation failure. Receives the file, the reason and the limits, and returns the sentence shown for it, so a page can say "documents" instead of "files" and add what happened to the rest of the batch. Defaults to a generic sentence naming the file and the limit. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

- `--cinder-file-upload-background`
- `--cinder-file-upload-border-color`
- `--cinder-file-upload-progress-background`
- `--cinder-file-upload-progress-fill`

<!-- generated:variables:end -->
