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
    ]);
  });
});
