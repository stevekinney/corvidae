/** Hand a text file to the user's browser. The text is already in memory; nothing is sent. */

export type TextDownload = { filename: string; mime: string; text: string };

export function downloadText(download: TextDownload): void {
  const url = URL.createObjectURL(new Blob([download.text], { type: download.mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = download.filename;
  link.click();
  URL.revokeObjectURL(url);
}
