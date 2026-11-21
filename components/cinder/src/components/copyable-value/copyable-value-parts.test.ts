/**
 * COR-2539 (design correction round 3): where an address may break. A host, a port and a file name
 * each stay whole until one is longer than the line; a dot is a break of last resort, never the
 * first choice (`127.0.0.|1`, `json` alone on a row).
 */
import { describe, expect, test } from 'bun:test';

import { splitValue } from './copyable-value-parts.ts';

const AGENT_CARD = 'http://127.0.0.1:7433/.well-known/agent-card.json';
const MCP_ADDRESS = 'http://127.0.0.1:7234/bureau/mcp';

describe('splitValue', () => {
  test('breaks the A2A address after its slashes and colons, and its dots only inside a part', () => {
    expect(splitValue(AGENT_CARD)).toEqual([
      ['http://'],
      ['127.', '0.', '0.', '1:'],
      ['7433/'],
      ['.well-known/'],
      ['agent-card.', 'json'],
    ]);
  });

  test('breaks the MCP address into the scheme, the host, the port and each path part', () => {
    expect(splitValue(MCP_ADDRESS)).toEqual([
      ['http://'],
      ['127.', '0.', '0.', '1:'],
      ['7234/'],
      ['bureau/'],
      ['mcp'],
    ]);
  });

  test('keeps a run of break characters together, so `://` is one stretch', () => {
    expect(splitValue('a://b')).toEqual([['a://'], ['b']]);
    expect(splitValue('a?x=1&y=2')).toEqual([['a?'], ['x='], ['1&'], ['y='], ['2']]);
  });

  test('a leading dot belongs to the name it starts, not a part of its own', () => {
    expect(splitValue('.well-known/')).toEqual([['.well-known/']]);
    expect(splitValue('a..b')).toEqual([['a..b']]);
  });

  test('gives back the value unchanged, whatever it holds', () => {
    for (const value of [
      AGENT_CARD,
      MCP_ADDRESS,
      'https://example.com/a/b.json?x=1&y=2',
      'abcdefgh',
      '/',
      '...',
      'abc\u{1F600}',
    ]) {
      expect(splitValue(value).flat().join('')).toBe(value);
    }
  });

  test('a value with nothing to break at is one part of one piece', () => {
    expect(splitValue('abcdefgh')).toEqual([['abcdefgh']]);
  });

  test('an empty value is one empty part, so the control still has a place', () => {
    expect(splitValue('')).toEqual([['']]);
  });
});
