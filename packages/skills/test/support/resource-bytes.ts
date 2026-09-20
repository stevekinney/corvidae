/**
 * Encoding helpers for tests that exercise the byte-level resource surface.
 *
 * Resources are stored as bytes so binary assets survive; a test whose subject is text still wants
 * to read and write text, and wrapping every literal inline would bury what each test is about.
 */
export function resourceBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function resourceText(bytes: Uint8Array | undefined): string | undefined {
  return bytes === undefined ? undefined : new TextDecoder('utf-8').decode(bytes);
}
