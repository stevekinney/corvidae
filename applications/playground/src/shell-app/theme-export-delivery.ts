/**
 * Getting an exported file to the user (COR-486): copy to the clipboard, or download it. A
 * clipboard that is missing, denied or failing never loses the export; the same text is handed
 * to the download instead and the message says so.
 */

import { downloadText, type TextDownload } from './theme-download.ts';

export type DeliveryDeps = {
  /** Defaults to the async clipboard; `undefined` when the browser has none. */
  writeText?: ((text: string) => Promise<void>) | undefined;
  download?: (file: TextDownload) => void;
};

export type DeliveryResult = { method: 'copied' | 'downloaded'; message: string };

function defaultWriteText(): ((text: string) => Promise<void>) | undefined {
  const clipboard = globalThis.navigator?.clipboard;
  return clipboard === undefined ? undefined : (text) => clipboard.writeText(text);
}

/** Copy `file.text`; on any clipboard failure download it and say that is what happened. */
export async function copyOrDownload(
  file: TextDownload,
  deps: DeliveryDeps = {},
): Promise<DeliveryResult> {
  const writeText = 'writeText' in deps ? deps.writeText : defaultWriteText();
  const download = deps.download ?? downloadText;
  if (writeText !== undefined) {
    try {
      await writeText(file.text);
      return { method: 'copied', message: `Copied ${file.filename} to the clipboard.` };
    } catch {
      // Fall through to the download below.
    }
  }
  download(file);
  return {
    method: 'downloaded',
    message: `The clipboard was not available, so ${file.filename} was downloaded instead.`,
  };
}

/** Hand back a file the user chose, byte for byte. The browser reads it; nothing is sent. */
export function downloadChosenFile(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  URL.revokeObjectURL(url);
}

export function downloadFile(file: TextDownload, deps: DeliveryDeps = {}): DeliveryResult {
  (deps.download ?? downloadText)(file);
  return { method: 'downloaded', message: `Downloaded ${file.filename}.` };
}
