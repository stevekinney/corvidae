/**
 * Whether an application may put `code` in a WebSocket close frame it sends. RFC 6455 reserves
 * 1004, 1005, 1006 and 1015 for local use, so 1006 in particular only ever describes a closure a
 * peer observed. 1010 is the one definition a server never sends, and 1016 through 2999 are held
 * for extensions.
 */
export function isSendableCloseCode(code: number): boolean {
  return (
    Number.isInteger(code) &&
    ((code >= 1000 && code <= 1003) ||
      (code >= 1007 && code <= 1009) ||
      (code >= 1011 && code <= 1014) ||
      (code >= 3000 && code <= 4999))
  );
}
