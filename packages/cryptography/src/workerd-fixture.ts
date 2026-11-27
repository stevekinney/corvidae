import {
  createIncrementalHash,
  hmacSha256HexSync,
  sha256Base64UrlSync,
  sha256BytesHex,
  sha256BytesHexSync,
  sha256Hex,
  sha256HexSync,
  timingSafeEqualHex,
  timingSafeEqualText,
} from './hash.ts';

export default {
  async fetch(): Promise<Response> {
    const incremental = createIncrementalHash();
    incremental.update('a');
    incremental.update('bc');
    return Response.json({
      bytes: sha256BytesHexSync(new Uint8Array([0x61, 0x62, 0x63])),
      bytesAsync: await sha256BytesHex(new Uint8Array([0x61, 0x62, 0x63])),
      hex: sha256HexSync('abc'),
      hexAsync: await sha256Hex('abc'),
      hmac: hmacSha256HexSync('key', 'abc'),
      incremental: incremental.digest(),
      pkce: sha256Base64UrlSync('abc'),
      textDifferent: timingSafeEqualText('abc', 'abd'),
      textEqual: timingSafeEqualText('é', 'é'),
      textLengthDifferent: timingSafeEqualText('é', 'e'),
      hexEqual: timingSafeEqualHex(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      ),
      hexDifferent: timingSafeEqualHex(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ae',
      ),
    });
  },
};
