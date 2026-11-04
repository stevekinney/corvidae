import { describe, expect, test } from 'bun:test';

import { IDENTIFIER_ACRONYMS, humanizeIdentifier } from './humanize-identifier.ts';

describe('humanizeIdentifier', () => {
  const table: readonly [key: string, expected: string, under?: string][] = [
    ['orderId', 'Order ID'],
    ['tool-runner', 'Tool Runner'],
    ['wrong_item', 'Wrong Item'],
    ['sessionInput.sessionBacklogLimit', 'Session Input ▶ Session Backlog Limit'],
    ['APIKey', 'API Key'],
    ['retention.audit', 'Audit', 'Retention'],
    ['orderIds', 'Order IDs'],
    ['userIDs', 'User IDs'],
    ['callbackUrl', 'Callback URL'],
    ['oauthToken', 'OAuth Token'],
    ['OAuthToken', 'OAuth Token'],
    ['HTTPSProxy', 'HTTPS Proxy'],
    ['s3Bucket', 'S3 Bucket'],
    ['S3Bucket', 'S3 Bucket'],
    ['a2a-endpoint', 'A2A Endpoint'],
    ['ag-ui', 'AG-UI'],
    ['ag-ui-events', 'AG-UI Events'],
    ['WRONG_ITEM', 'Wrong Item'],
    ['path/to file', 'Path To File'],
    ['  padded  ', 'Padded'],
    ['ttlMilliseconds', 'TTL Milliseconds'],
    ['value', 'Value'],
    ['', ''],
    ['retention', 'Retention', 'Retention'],
    ['retentionAudit', 'Audit', 'Retention'],
    ['retention.audit.days', 'Audit ▶ Days', 'retention'],
    ['retention.audit', 'Retention ▶ Audit', 'Audit'],
    ['auditLog', 'Audit Log', 'Audit Log'],
  ];

  for (const [key, expected, under] of table) {
    test(`${JSON.stringify(key)}${under === undefined ? '' : ` under ${under}`} → ${JSON.stringify(expected)}`, () => {
      expect(humanizeIdentifier(key, under === undefined ? {} : { under })).toBe(expected);
    });
  }

  test('sentence casing capitalizes only the first word of each segment and keeps acronyms', () => {
    const sentence = (key: string, under?: string) =>
      humanizeIdentifier(
        key,
        under === undefined ? { casing: 'sentence' } : { casing: 'sentence', under },
      );
    expect(sentence('timeZone')).toBe('Time zone');
    expect(sentence('catch_up')).toBe('Catch up');
    expect(sentence('orderId')).toBe('Order ID');
    expect(sentence('apiKey')).toBe('API key');
    expect(sentence('tool-runner')).toBe('Tool runner');
    expect(sentence('retention.auditLog')).toBe('Retention ▶ Audit log');
    expect(sentence('retentionAudit', 'Retention')).toBe('Audit');
  });

  test('every acronym in the list formats as itself', () => {
    for (const acronym of IDENTIFIER_ACRONYMS) {
      expect(humanizeIdentifier(acronym.toLowerCase())).toBe(acronym);
    }
  });

  test('the acronym list carries the agreed spellings', () => {
    expect(IDENTIFIER_ACRONYMS).toEqual([
      'API',
      'ID',
      'IDs',
      'URL',
      'URLs',
      'URI',
      'UUID',
      'JSON',
      'YAML',
      'HTML',
      'CSS',
      'HTTP',
      'HTTPS',
      'SSE',
      'MCP',
      'CLI',
      'SQL',
      'S3',
      'OAuth',
      'TTL',
      'CPU',
      'GPU',
      'UI',
      'UX',
      'LLM',
      'AI',
      'PR',
      'JWT',
      'TLS',
      'SSH',
      'UTC',
      'AG-UI',
      'A2A',
      'SKU',
    ]);
  });
});
