/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { createEditorAttachment } from './attach.js';
import * as editorRuntime from './editor.js';
import type { EditorConfig, EditorState } from './types.js';

const initializeEditor = editorRuntime.createEditor;
const releaseEditor = editorRuntime.destroyEditor;
let initializedState: EditorState | undefined;
let resolveCreatedEditor: ((state: EditorState) => void) | undefined;
let rejectCreatedEditor: ((error: unknown) => void) | undefined;

const createEditorMock = mock((_element: HTMLElement, _configuration?: EditorConfig) => {
  return new Promise<EditorState>((resolve, reject) => {
    resolveCreatedEditor = resolve;
    rejectCreatedEditor = reject;
  });
});

const destroyEditorMock = mock(async (_state: EditorState) => {});

function createEditorState(): EditorState {
  if (!initializedState) throw new Error('Editor fixture was not initialized');
  return initializedState;
}

function createAttachmentOptions(
  overrides: Partial<Parameters<typeof createEditorAttachment>[0]> = {},
) {
  return {
    getInitialValue: () => 'Initial markdown',
    getReadonly: () => false,
    getAriaLabel: () => 'Markdown editor',
    ...overrides,
  };
}

function createEditorElement(): HTMLElement {
  return document.createElement('div');
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * The `Attachment` type allows a `void | (() => void)` return, but
 * `createEditorAttachment` always returns a cleanup function. Narrow it once
 * here instead of asserting at every call site.
 */
function expectDetachFunction(detach: void | (() => void)): () => void {
  if (typeof detach !== 'function') {
    throw new Error('expected the attachment to return a detach function');
  }
  return detach;
}

describe('createEditorAttachment', () => {
  beforeEach(async () => {
    initializedState = await initializeEditor(createEditorElement());
    resolveCreatedEditor = undefined;
    rejectCreatedEditor = undefined;
    createEditorMock.mockClear();
    destroyEditorMock.mockClear();
    spyOn(editorRuntime, 'createEditor').mockImplementation(createEditorMock);
    spyOn(editorRuntime, 'destroyEditor').mockImplementation(destroyEditorMock);
  });

  afterEach(async () => {
    mock.restore();
    if (initializedState) await releaseEditor(initializedState);
    initializedState = undefined;
  });

  test('destroys the editor when initialization resolves after detach', async () => {
    const onready = mock((_state: EditorState) => {});
    const attachment = createEditorAttachment(createAttachmentOptions({ onready }));
    const detach = expectDetachFunction(attachment(createEditorElement()));

    detach();

    const editorState = createEditorState();
    resolveCreatedEditor?.(editorState);
    await flushMicrotasks();

    expect(onready).not.toHaveBeenCalled();
    expect(destroyEditorMock).toHaveBeenCalledTimes(1);
    expect(destroyEditorMock).toHaveBeenCalledWith(editorState);
  });

  test('reports initialization failures after detach', async () => {
    const originalReportError = globalThis.reportError;
    const reportErrorMock = mock((_error?: unknown) => {});
    globalThis.reportError = reportErrorMock;

    try {
      const attachment = createEditorAttachment(createAttachmentOptions());
      const detach = expectDetachFunction(attachment(createEditorElement()));

      detach();
      rejectCreatedEditor?.(new Error('late Milkdown initialization failure'));
      await flushMicrotasks();
    } finally {
      globalThis.reportError = originalReportError;
    }

    expect(reportErrorMock).toHaveBeenCalledWith(expect.any(Error));
  });

  test('reports destruction failures after a mounted editor detaches', async () => {
    const originalReportError = globalThis.reportError;
    const reportErrorMock = mock((_error?: unknown) => {});
    const failure = new Error('Milkdown destruction failed');
    globalThis.reportError = reportErrorMock;
    destroyEditorMock.mockImplementationOnce(async () => {
      throw failure;
    });

    try {
      const attachment = createEditorAttachment(createAttachmentOptions());
      const detach = expectDetachFunction(attachment(createEditorElement()));
      const state = createEditorState();
      resolveCreatedEditor?.(state);
      await flushMicrotasks();

      detach();
      await flushMicrotasks();

      expect(destroyEditorMock).toHaveBeenCalledWith(state);
      expect(reportErrorMock).toHaveBeenCalledTimes(1);
      expect(reportErrorMock).toHaveBeenCalledWith(failure);
    } finally {
      globalThis.reportError = originalReportError;
    }
  });
});
