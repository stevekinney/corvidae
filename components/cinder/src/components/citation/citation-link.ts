/**
 * What a source's `url` lets a citation draw: a link to a safe web address, nothing because the
 * source has no address, or a note that its address was refused.
 */
export type CitationLink =
  | {
      /** The address is a safe web link. */
      kind: 'link';
      /** The address to link to, trimmed. */
      href: string;
      /** The host of an absolute address, such as `example.com`; `undefined` for a relative one. */
      host: string | undefined;
    }
  | {
      /** The source has no address, such as an internal document. */
      kind: 'none';
    }
  | {
      /** The source has an address, but it is not a safe web link. */
      kind: 'rejected';
    };

function hasUnsafeUrlCharacter(url: string): boolean {
  for (const character of url) {
    if (character === '\\') return true;
    const codePoint = character.charCodeAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

/**
 * Applies Citation's URL policy to a source's address. An `http:` or `https:` address, or a
 * relative path, is a link; a missing or blank address is `none`; any other scheme (such as
 * `javascript:` or `data:`), a protocol-relative `//host` address, a backslash or a control
 * character is `rejected`. It only reads the string, so resolving a source never fetches it.
 */
export function resolveCitationLink(url: string | undefined): CitationLink {
  const trimmed = url?.trim();
  if (!trimmed) return { kind: 'none' };
  if (hasUnsafeUrlCharacter(trimmed) || /^[\\/]{2}/.test(trimmed)) return { kind: 'rejected' };

  if (/^[A-Za-z][A-Za-z\d+.-]*:/.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { kind: 'rejected' };
      return { kind: 'link', href: trimmed, host: parsed.host === '' ? undefined : parsed.host };
    } catch {
      return { kind: 'rejected' };
    }
  }

  return { kind: 'link', href: trimmed, host: undefined };
}
