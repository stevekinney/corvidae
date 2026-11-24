import { timingSafeEqual } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { canonicalizeIpAddress, expandIpv6Groups } from './canonicalize-ip-address.ts';

function ipToBigInt(address: string): { family: 4 | 6; value: bigint } | null {
  if (isIPv4(address)) {
    return {
      family: 4,
      value: address
        .split('.')
        .map(Number)
        .reduce((value, octet) => (value << 8n) + BigInt(octet), 0n),
    };
  }
  if (!isIPv6(address)) return null;
  return {
    family: 6,
    value: expandIpv6Groups(address).reduce(
      (value, group) => (value << 16n) + BigInt(Number.parseInt(group, 16)),
      0n,
    ),
  };
}

function parseCidr(cidr: string): { family: 4 | 6; value: bigint; prefixLength: number } | null {
  const [address, prefixText, extra] = cidr.split('/');
  if (!address || !prefixText || extra !== undefined || !/^\d+$/.test(prefixText)) return null;
  const range = ipToBigInt(canonicalizeIpAddress(address));
  if (!range) return null;
  const prefixLength = Number.parseInt(prefixText, 10);
  if (prefixLength > (range.family === 4 ? 32 : 128)) return null;
  return { ...range, prefixLength };
}

export function isAddressInCidr(address: string, cidr: string): boolean {
  const range = parseCidr(cidr);
  const candidate = ipToBigInt(canonicalizeIpAddress(address));
  if (!range || !candidate || candidate.family !== range.family) return false;
  if (range.prefixLength === 0) return true;
  const shift = BigInt((candidate.family === 4 ? 32 : 128) - range.prefixLength);
  return candidate.value >> shift === range.value >> shift;
}

export function isValidCidr(cidr: string): boolean {
  return parseCidr(cidr) !== null;
}

export function isValidRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.hash || parsed.username || parsed.password || parsed.hostname.includes('*'))
    return false;
  if (parsed.protocol === 'https:') return true;
  return (
    parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  );
}

// Control characters are the security boundary this expression enforces.
// eslint-disable-next-line no-control-regex
const controlCharacterPattern = /[\u0000-\u001F\u007F-\u009F]/;
const bidiControlCharacterPattern = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const zeroWidthCharacterPattern = /[\u200B-\u200D\uFEFF]/;
const latinScriptCharacterPattern = /\p{Script=Latin}/u;
const confusableWithLatinScriptCharacterPattern = /\p{Script=Cyrillic}|\p{Script=Greek}/u;

export function isValidClientName(name: string): boolean {
  return (
    Boolean(name) &&
    !controlCharacterPattern.test(name) &&
    !bidiControlCharacterPattern.test(name) &&
    !zeroWidthCharacterPattern.test(name) &&
    !(
      latinScriptCharacterPattern.test(name) && confusableWithLatinScriptCharacterPattern.test(name)
    )
  );
}

export function isExactContentType(value: string | null, expectedMediaType: string): boolean {
  if (value === null) return false;
  let inQuotes = false;
  for (const character of value) {
    if (character === '"') inQuotes = !inQuotes;
    else if (character === ',' && !inQuotes) return false;
  }
  return value.split(';')[0]?.trim().toLowerCase() === expectedMediaType;
}

/** Compares UTF-8 credentials without data-dependent comparison timing. */
export function constantTimeEquals(leftValue: string, rightValue: string): boolean {
  const leftBuffer = Buffer.from(leftValue, 'utf8');
  const rightBuffer = Buffer.from(rightValue, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function withDeadline<T>(promise: Promise<T>, timeoutMilliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMilliseconds}ms`)),
      timeoutMilliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        return resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        return reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
