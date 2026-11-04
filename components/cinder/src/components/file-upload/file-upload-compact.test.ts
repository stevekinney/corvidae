/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

import type { FileUploadEntry, FileUploadProps, FileUploadRejection } from './file-upload.types.ts';

setupHappyDom();

const { cleanup, fireEvent, render, screen } = await import('@testing-library/svelte');
const { default: FileUpload } = await import('./file-upload.svelte');
const { default: ControlledFileUpload } = await import('./file-upload-compact-fixture.test.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const KILOBYTE = 1024;
const MEGABYTE = 1024 * KILOBYTE;

function createFile(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { configurable: true, value: size });
  return file;
}

function createDropEvent(files: File[]): DragEvent {
  const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, 'dataTransfer', {
    configurable: true,
    value: { files, types: ['Files'], dropEffect: 'none' },
  });
  return event;
}

function dropzone(container: HTMLElement): HTMLElement {
  return requiredInstance(container.querySelector('.cinder-file-upload__dropzone'), HTMLElement);
}

const settled: FileUploadEntry = {
  id: 'refund',
  file: createFile('Refund policy.md', 'text/markdown', 4 * KILOBYTE),
  status: 'ready',
};

const arriving: FileUploadEntry = {
  id: 'returns',
  file: createFile('Returns policy.pdf', 'application/pdf', 2 * MEGABYTE),
  status: 'uploading',
  progress: 60,
};

const documentWords = ({ file, maxSize }: FileUploadRejection) =>
  `${file.name} is 12 MB; documents can be up to ${(maxSize ?? 0) / MEGABYTE} MB. Nothing was added.`;

describe('FileUpload compact variant: uploading (row 43b)', () => {
  const props: FileUploadProps = {
    id: 'documents',
    variant: 'compact',
    multiple: true,
    browseLabel: 'Add a document',
    description: 'or drop files here · PDF, Markdown or text · up to 5 MB each',
    files: [settled, arriving],
    onFilesChange: () => {},
  };

  test('a settled file is a row with its name, its size and a remove button', () => {
    const { container } = render(FileUpload, { props });
    const row = requiredInstance(
      container.querySelector('.cinder-file-upload__compact-row'),
      HTMLElement,
    );
    expect(row.textContent).toContain('Refund policy.md');
    expect(row.textContent).toContain('4 KB');
    expect(row.querySelector('.cinder-file-upload__file-icon')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove Refund policy.md' })).toBeTruthy();
  });

  test('the arriving file is one line: name, a bar at 60%, 60%, and Cancel upload', async () => {
    const onFileCancel = mock((_entry: unknown) => {});
    const { container } = render(FileUpload, { props: { ...props, onFileCancel } });
    const row = requiredInstance(
      container.querySelector('.cinder-file-upload__upload-row'),
      HTMLElement,
    );
    expect(row.textContent).toContain('Returns policy.pdf');
    expect(row.textContent).toContain('60%');
    const bar = screen.getByRole('progressbar', { name: 'Uploading Returns policy.pdf' });
    expect(bar.getAttribute('aria-valuenow')).toBe('60');
    expect(row.textContent).toContain('Cancel upload');
    await fireEvent.click(
      screen.getByRole('button', { name: /Cancel upload: Returns policy.pdf/ }),
    );
    expect(onFileCancel).toHaveBeenCalledTimes(1);
    expect(onFileCancel.mock.calls[0]?.[0]).toMatchObject({ id: 'returns' });
  });

  test('an uploading file has no cancel action unless the page handles it', () => {
    const { container } = render(FileUpload, { props });
    expect(container.querySelector('.cinder-file-upload__upload-row')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Cancel upload/ })).toBeNull();
  });

  test('the Add a document zone stays below the list and carries its one line of help', () => {
    const { container } = render(FileUpload, { props });
    const zone = dropzone(container);
    const rows = requiredInstance(
      container.querySelector('.cinder-file-upload__compact-rows'),
      HTMLElement,
    );
    expect(rows.compareDocumentPosition(zone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(zone.textContent).toContain('Add a document');
    expect(zone.textContent).toContain(
      'or drop files here · PDF, Markdown or text · up to 5 MB each',
    );
    expect(zone.querySelector('.cinder-file-upload__title')).toBeNull();
    expect(zone.getAttribute('data-variant')).toBe('compact');
  });

  test('a cancel leaves focus on a row action, not on the page', async () => {
    const onFileCancel = mock((_entry: unknown) => {});
    const { container } = render(FileUpload, { props: { ...props, onFileCancel } });
    const cancel = screen.getByRole('button', { name: /Cancel upload: Returns policy.pdf/ });
    cancel.focus();
    await fireEvent.click(cancel);
    expect(onFileCancel).toHaveBeenCalledTimes(1);
    expect(container.contains(document.activeElement) || document.activeElement === cancel).toBe(
      true,
    );
  });
});

describe('FileUpload compact variant: file too large (row 43c)', () => {
  const props: FileUploadProps = {
    id: 'documents',
    variant: 'compact',
    multiple: true,
    maxSize: 5 * MEGABYTE,
    browseLabel: 'Add a document',
    rejectionMessage: documentWords,
    files: [settled],
  };

  test('an over-limit file is an alert naming the file and the limit, not a row', async () => {
    const onReject = mock((_files: unknown) => {});
    const { container } = render(ControlledFileUpload, { props: { ...props, onReject } });
    await fireEvent(
      dropzone(container),
      createDropEvent([createFile('Customer export.csv', 'text/csv', 12 * MEGABYTE)]),
    );
    expect(onReject).toHaveBeenCalledTimes(1);
    const alert = screen.getByRole('alert');
    expect(alert.textContent?.trim()).toBe(
      'Customer export.csv is 12 MB; documents can be up to 5 MB. Nothing was added.',
    );
    expect(alert.getAttribute('data-cinder-variant')).toBe('danger');
    expect(container.textContent).not.toContain('Customer export.csv 12 MB');
  });

  test('the existing row and the drop zone stay beside the alert', async () => {
    const { container } = render(ControlledFileUpload, { props });
    await fireEvent(
      dropzone(container),
      createDropEvent([createFile('Customer export.csv', 'text/csv', 12 * MEGABYTE)]),
    );
    expect(container.querySelectorAll('.cinder-file-upload__compact-row')).toHaveLength(1);
    expect(container.textContent).toContain('Refund policy.md');
    const alert = screen.getByRole('alert');
    const zone = dropzone(container);
    expect(alert.compareDocumentPosition(zone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(zone.textContent).toContain('Add a document');
  });

  test('uncontrolled, the rejection is an alert and the next valid file clears it', async () => {
    const { container } = render(FileUpload, {
      props: { id: 'documents', variant: 'compact', multiple: true, maxSize: 5 * MEGABYTE },
    });
    await fireEvent(
      dropzone(container),
      createDropEvent([createFile('Customer export.csv', 'text/csv', 12 * MEGABYTE)]),
    );
    expect(screen.queryAllByRole('alert')).toHaveLength(1);
    expect(container.querySelector('.cinder-file-upload__compact-row')).toBeNull();
    await fireEvent(
      dropzone(container),
      createDropEvent([createFile('Refund policy.md', 'text/markdown', 4 * KILOBYTE)]),
    );
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(container.querySelectorAll('.cinder-file-upload__compact-row')).toHaveLength(1);
  });

  test('the default message names the file and the limit when the page gives none', async () => {
    const { container } = render(FileUpload, {
      props: { id: 'documents', variant: 'compact', multiple: true, maxSize: 5 * MEGABYTE },
    });
    await fireEvent(
      dropzone(container),
      createDropEvent([createFile('Customer export.csv', 'text/csv', 12 * MEGABYTE)]),
    );
    expect(screen.getByRole('alert').textContent?.trim()).toBe(
      'Customer export.csv is 12 MB; maximum is 5 MB',
    );
  });

  test('the dropzone variant keeps a rejection as a row that names the file', async () => {
    const { container } = render(FileUpload, {
      props: { id: 'documents', multiple: true, maxSize: 5 * MEGABYTE },
    });
    await fireEvent(
      dropzone(container),
      createDropEvent([createFile('Customer export.csv', 'text/csv', 12 * MEGABYTE)]),
    );
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(container.querySelector('.cinder-file-upload__row')?.textContent).toContain(
      'Customer export.csv',
    );
  });
});

describe('FileUpload button variant (row 33s)', () => {
  const props: FileUploadProps = {
    id: 'spec',
    variant: 'button',
    browseLabel: 'Upload a file',
    accept: '.yaml,.yml,.json',
    summary: 'payments-openapi.yaml · OpenAPI 3.1 · 24 operations',
  };

  test('draws the Upload a file button and the file summary, and no dropzone body', () => {
    const { container } = render(FileUpload, { props });
    const zone = dropzone(container);
    expect(zone.getAttribute('data-variant')).toBe('button');
    expect(screen.getByRole('button', { name: 'Upload a file' })).toBeTruthy();
    expect(zone.textContent).toContain('payments-openapi.yaml · OpenAPI 3.1 · 24 operations');
    expect(zone.querySelector('.cinder-file-upload__upload-icon')).toBeNull();
    expect(zone.querySelector('.cinder-file-upload__title')).toBeNull();
  });

  test('the button carries an upload glyph and the summary is the input description', () => {
    const { container } = render(FileUpload, { props });
    expect(
      screen.getByRole('button', { name: 'Upload a file' }).querySelector('svg'),
    ).not.toBeNull();
    const summary = requiredInstance(
      container.querySelector('.cinder-file-upload__line'),
      HTMLElement,
    );
    const input = requiredInstance(container.querySelector('input[type="file"]'), HTMLInputElement);
    expect(input.getAttribute('aria-describedby')).toContain(summary.id);
  });

  test('a chosen file draws no row, and a rejected one is an alert', async () => {
    const onFilesChange = mock((_entries: unknown) => {});
    const { container } = render(FileUpload, {
      props: { ...props, maxSize: MEGABYTE, onFilesChange },
    });
    await fireEvent(
      dropzone(container),
      createDropEvent([createFile('payments-openapi.yaml', 'application/yaml', 2 * KILOBYTE)]),
    );
    expect(onFilesChange).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.cinder-file-upload__list')).toBeNull();
    expect(container.querySelector('.cinder-file-upload__compact-rows')).toBeNull();
    await fireEvent(
      dropzone(container),
      createDropEvent([createFile('huge.yaml', 'application/yaml', 2 * MEGABYTE)]),
    );
    expect(screen.getByRole('alert').textContent?.trim()).toBe(
      'huge.yaml is 2 MB; maximum is 1 MB',
    );
  });
});
