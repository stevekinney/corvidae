/**
 * Format bytes to a human-readable size string.
 *
 * @param bytes - Number of bytes
 * @returns Formatted string (e.g., "1.5 KB", "2.3 MB", "512 B")
 *
 * @example
 * formatBytes(512) // "512 B"
 * formatBytes(1536) // "1.5 KB"
 * formatBytes(2621440) // "2.5 MB"
 * formatBytes(245760) // "240 KB"
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${oneDecimal(bytes / 1024)} KB`;
  return `${oneDecimal(bytes / (1024 * 1024))} MB`;
}

/** One decimal place, without a trailing `.0`: `240` rather than `240.0`. */
function oneDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}
