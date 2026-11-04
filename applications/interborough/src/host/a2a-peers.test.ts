import { describe, expect, test } from 'bun:test';

import { parseA2APeersConfiguration, readA2APeersConfiguration } from './a2a-peers.ts';
import { ProviderConfigurationError } from './provider-configuration-error.ts';

describe('configured A2A peers', () => {
  test('parses valid peers and optional bearer secret names', () => {
    expect(
      parseA2APeersConfiguration(
        [
          {
            id: 'research',
            description: 'Research peer',
            url: 'https://peer.example/a2a',
            bearerSecret: 'peer-token',
          },
        ],
        '/home/configuration.json',
      ),
    ).toEqual([
      {
        id: 'research',
        description: 'Research peer',
        url: 'https://peer.example/a2a',
        bearerSecret: 'peer-token',
      },
    ]);
  });

  test('rejects malformed and duplicate entries at startup', () => {
    const invalid = () =>
      parseA2APeersConfiguration(
        [{ id: 'research', description: 'Research peer', url: 'not a URL' }],
        '/home/configuration.json',
      );
    expect(invalid).toThrow(ProviderConfigurationError);
    expect(() =>
      parseA2APeersConfiguration(
        [
          { id: 'research', description: 'One', url: 'https://one.example' },
          { id: 'research', description: 'Two', url: 'https://two.example' },
        ],
        '/home/configuration.json',
      ),
    ).toThrow('another peer has this identifier');
  });

  test('reads the optional configuration key without changing other settings', () => {
    expect(
      readA2APeersConfiguration('{"plugins":{},"a2aPeers":[]}', '/home/configuration.json'),
    ).toEqual([]);
    expect(readA2APeersConfiguration(undefined, '/home/configuration.json')).toEqual([]);
  });
});
