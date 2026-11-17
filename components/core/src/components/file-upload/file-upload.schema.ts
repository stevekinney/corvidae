import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    accept: {
      type: 'string',
      description: 'Native file accept filter.',
    },
    disabled: {
      type: 'boolean',
      description: 'Disables the file picker and drag-and-drop surface.',
    },
    multiple: {
      type: 'boolean',
      description: 'Allow more than one file. Default `false`.',
    },
    name: {
      type: 'string',
      description: 'Native input name used for form submission.',
    },
    id: {
      type: 'string',
      description: 'Stable id for the native file input. Required when composing with `FormField`.',
    },
    title: {
      type: 'string',
      description: 'Visible title for the dropzone.',
      default: 'Click to upload or drop files',
    },
    maxSize: {
      type: 'number',
      description: 'Maximum allowed file size in bytes.',
    },
    maxFiles: {
      type: 'number',
      description: 'Maximum number of files allowed. Files beyond this limit are rejected.',
    },
    variant: {
      enum: ['dropzone', 'compact', 'button'],
      description:
        "How the surface is drawn.\n- `'dropzone'` is the large dashed area with a title, a description and a Browse button, the\n  file rows below it.\n- `'compact'` is a one-line dashed zone (a secondary button and one line of text) that sits\n  under the file rows, for a short list on a form. The rows are one bordered list (name, size,\n  remove), an uploading file is one line (name, bar, percent, Cancel upload), and a file that\n  fails local validation is a danger alert between the rows and the zone saying nothing was\n  added, not a row. The alert stays until the next file is chosen.\n- `'button'` is just the secondary button and a line of text beside it (`summary`), for one\n  file whose details the page already shows. It draws no rows; read the files through\n  `onFilesChange`. A rejection is still an alert.",
      default: 'dropzone',
    },
    summary: {
      type: 'string',
      description:
        "The line of text beside the button in the `'button'` variant, usually what was uploaded, such\nas the file name and what was read from it. Falls back to `description`.",
    },
    cancelLabel: {
      type: 'string',
      description:
        'Visible text of the cancel action on an uploading file. Only drawn when `onFileCancel` is set.',
      default: 'Cancel upload',
    },
    class: {
      type: 'string',
      description: 'Additional classes merged with `.cinder-file-upload`.',
    },
    description: {
      type: 'string',
      description:
        'Visible description below the title. Defaults to a summary derived from `accept`.',
    },
    draggingLabel: {
      type: 'string',
      description: 'Visible label shown while files are dragged over the dropzone.',
      default: 'Drop to add',
    },
    browseLabel: {
      type: 'string',
      description: 'Visible text for the browse button.',
      default: 'Browse files',
    },
    borderBeamVisible: {
      type: 'boolean',
      description: 'Adds focus and drag-active border emphasis to the dropzone.',
      default: true,
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'dragActive',
        reason: 'function-or-snippet',
        description: 'Replaces the default drag-active dropzone body.',
      },
      {
        name: 'fileList',
        reason: 'function-or-snippet',
        description:
          'Replaces the default file-list renderer. Receives the live resolved rows, including an empty array, and a removal callback when the queue is mutable.',
      },
      {
        name: 'files',
        reason: 'unknown-shape',
        description: 'Consumer-driven file rows, including upload progress and error states.',
      },
      {
        name: 'idle',
        reason: 'function-or-snippet',
        description: 'Replaces the default resting-state dropzone body.',
      },
      {
        name: 'onFileCancel',
        reason: 'function-or-snippet',
        description:
          'Called when Cancel upload is activated on an uploading file. The component does not remove the\nrow itself: stop the upload and drop the entry from `files`. Without it an uploading file has\nno cancel action.',
      },
      {
        name: 'onFileRetry',
        reason: 'function-or-snippet',
        description: 'Called when the retry button is activated for a failed file.',
      },
      {
        name: 'onFilesAccepted',
        reason: 'function-or-snippet',
        description: 'Fires with accepted files after local validation passes.',
      },
      {
        name: 'onFilesChange',
        reason: 'function-or-snippet',
        description: 'Fires with the full resolved entry list after local validation changes it.',
      },
      {
        name: 'onReject',
        reason: 'function-or-snippet',
        description: 'Fires with rejected files and reasons after local validation runs.',
      },
      {
        name: 'rejectionMessage',
        reason: 'function-or-snippet',
        description:
          'Words for a local validation failure. Receives the file, the reason and the limits, and\nreturns the sentence shown for it, so a page can say "documents" instead of "files" and add\nwhat happened to the rest of the batch. Defaults to a generic sentence naming the file and\nthe limit.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
