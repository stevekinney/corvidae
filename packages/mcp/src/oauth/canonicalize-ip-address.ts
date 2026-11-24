import { isIPv4, isIPv6 } from 'node:net';

/**
 * Expands an IPv6 address (including one with an embedded IPv4 dotted-quad
 * suffix, e.g. `::ffff:192.168.1.1`) into its eight zero-padded hextet
 * groups. Exported so trusted-proxy CIDR matching can reuse the same
 * parsing instead of re-deriving it.
 */
export function expandIpv6Groups(address: string): string[] {
  let workingAddress = address;

  const lastColonIndex = workingAddress.lastIndexOf(':');
  const tail = workingAddress.slice(lastColonIndex + 1);
  if (tail.includes('.') && isIPv4(tail)) {
    const octets = tail.split('.').map(Number);
    const highGroup = ((octets[0]! << 8) | octets[1]!).toString(16).padStart(4, '0');
    const lowGroup = ((octets[2]! << 8) | octets[3]!).toString(16).padStart(4, '0');
    workingAddress = `${workingAddress.slice(0, lastColonIndex + 1)}${highGroup}:${lowGroup}`;
  }

  let groups: string[];
  if (workingAddress.includes('::')) {
    const [head, tailPart] = workingAddress.split('::');
    const headGroups = head ? head.split(':').filter(Boolean) : [];
    const tailGroups = tailPart ? tailPart.split(':').filter(Boolean) : [];
    const missingGroupCount = 8 - headGroups.length - tailGroups.length;
    groups = [...headGroups, ...Array<string>(missingGroupCount).fill('0'), ...tailGroups];
  } else {
    groups = workingAddress.split(':');
  }

  return groups.map((group) => group.padStart(4, '0').toLowerCase());
}

function compressIpv6Groups(groups: string[]): string {
  const stripped = groups.map((group) => group.replace(/^0+(?=.)/, ''));

  let bestStart = -1;
  let bestLength = 0;
  let currentStart = -1;
  let currentLength = 0;

  for (let index = 0; index < stripped.length; index += 1) {
    if (stripped[index] === '0') {
      if (currentStart === -1) currentStart = index;
      currentLength += 1;
      if (currentLength > bestLength) {
        bestLength = currentLength;
        bestStart = currentStart;
      }
    } else {
      currentStart = -1;
      currentLength = 0;
    }
  }

  if (bestLength < 2) {
    return stripped.join(':');
  }

  const before = stripped.slice(0, bestStart).join(':');
  const after = stripped.slice(bestStart + bestLength).join(':');
  return `${before}::${after}`;
}

/**
 * Extracts the IPv4 address embedded in an IPv4-mapped IPv6 address
 * (`::ffff:a.b.c.d`), given its expanded, zero-padded hextet groups.
 * Returns `null` when the groups do not represent a mapped address.
 */
function extractIpv4MappedAddress(groups: string[]): string | null {
  const isMapped = groups.slice(0, 5).every((group) => group === '0000') && groups[5] === 'ffff';
  if (!isMapped) return null;

  const highGroup = Number.parseInt(groups[6]!, 16);
  const lowGroup = Number.parseInt(groups[7]!, 16);
  return [highGroup >> 8, highGroup & 0xff, lowGroup >> 8, lowGroup & 0xff].join('.');
}

/**
 * Strips a trailing `:port` suffix from an address/port pair, handling
 * both bracketed IPv6 (`[2001:db8::1]:4711`) and IPv4 (`1.2.3.4:5678`)
 * forms. Returns the input unchanged when no port suffix is present.
 */
function stripPort(input: string): string {
  const trimmed = input.trim();

  const bracketedMatch = /^\[([^\]]+)]:\d+$/.exec(trimmed);
  if (bracketedMatch) {
    return bracketedMatch[1]!;
  }

  if (/^\[[^\]]+]$/.test(trimmed)) {
    return trimmed.slice(1, -1);
  }

  const ipv4WithPortMatch = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(trimmed);
  if (ipv4WithPortMatch) {
    return ipv4WithPortMatch[1]!;
  }

  return trimmed;
}

/**
 * Canonicalizes an IPv4, IPv4-mapped IPv6, or IPv6 address string into one
 * consistent representation: lowercase, zone-id stripped, IPv4-mapped IPv6
 * collapsed to plain IPv4, and IPv6 compressed per RFC 5952. Addresses that
 * are not valid IPv4/IPv6 are returned lowercased and trimmed as-is.
 */
export function canonicalizeIpAddress(input: string): string {
  const withoutPort = stripPort(input);
  const withoutZone = withoutPort.split('%')[0]?.trim().toLowerCase() ?? '';

  if (isIPv4(withoutZone)) {
    return withoutZone;
  }

  if (isIPv6(withoutZone)) {
    const groups = expandIpv6Groups(withoutZone);
    const mappedIpv4 = extractIpv4MappedAddress(groups);
    if (mappedIpv4) {
      return mappedIpv4;
    }
    return compressIpv6Groups(groups);
  }

  return withoutZone;
}
