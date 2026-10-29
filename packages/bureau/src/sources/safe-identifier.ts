/**
 * The identifier check the file-backed definition sources share (COR-1702, COR-1762).
 *
 * @module safe-identifier
 */

/**
 * Throw a `TypeError` unless `id` names one entry directly inside a directory or under an object
 * prefix and nothing else: not empty, not a dotfile, and no path separator or NUL.
 */
export function assertSafeIdentifier(id: string): void {
  if (id === '' || id.startsWith('.') || /[\\/\0]/.test(id)) {
    throw new TypeError(`"${id}" is not an identifier a definition source can hold.`);
  }
}
