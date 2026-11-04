/**
 * Format bytes to a human-readable size string. A whole number prints without a decimal, so a
 * 4096-byte file is "4 KB" and a 12 MB file is "12 MB".
 *
 * @param bytes - Number of bytes
 * @returns Formatted string (e.g., "1.5 KB", "2.3 MB", "512 B")
 *
 * @example
 * formatBytes(512) // "512 B"
 * formatBytes(1536) // "1.5 KB"
 * formatBytes(4096) // "4 KB"
 * formatBytes(2621440) // "2.5 MB"
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${trimmed(bytes / 1024)} KB`;
  return `${trimmed(bytes / (1024 * 1024))} MB`;
}

function trimmed(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}
