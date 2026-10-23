import { describe, expect, test } from 'bun:test';

import {
  approvalQuestion,
  argumentLine,
  declaredSummary,
  resultSummary,
  shorten,
} from './tool-text.ts';

describe('declaredSummary', () => {
  test('is the message when the tool wrote one, and nothing when it is the reason again', () => {
    expect(declaredSummary('Refund order order-1001 for $42.00', 'Tool requires approval.')).toBe(
      'Refund order order-1001 for $42.00',
    );
    expect(declaredSummary('Tool requires approval.', 'Tool requires approval.')).toBeUndefined();
    expect(declaredSummary('  ', 'x')).toBeUndefined();
    expect(declaredSummary(undefined, 'x')).toBeUndefined();
  });
});

describe('approvalQuestion', () => {
  test('is the tool’s own sentence, ending in one question mark', () => {
    expect(
      approvalQuestion({ toolName: 'issue-refund', arguments: {}, summary: 'Refund order x.' }),
    ).toBe('Refund order x?');
    expect(approvalQuestion({ toolName: 't', arguments: {}, summary: 'Go?' })).toBe('Go?');
  });

  test('names the tool and its arguments when the tool wrote no sentence', () => {
    expect(
      approvalQuestion({
        toolName: 'issue-refund',
        arguments: { orderId: 'order-1001', cents: 4200 },
        summary: undefined,
      }),
    ).toBe('Run issue-refund with orderId order-1001, cents 4200?');
    expect(approvalQuestion({ toolName: 'ping', arguments: {}, summary: undefined })).toBe(
      'Run ping?',
    );
  });
});

describe('the lines about a call', () => {
  test('argumentLine joins keys and values, and a non-object argument is its own value', () => {
    expect(argumentLine({ a: 1, b: 'two', c: { d: 3 } })).toBe('a 1, b two, c {"d":3}');
    expect(argumentLine('plain')).toBe('value plain');
    expect(argumentLine(undefined)).toBe('');
  });

  test('resultSummary shows text, fields, or nothing, cut to one short line', () => {
    expect(resultSummary('found it')).toBe('found it');
    expect(resultSummary({ status: 'delivered', totalCents: 4200 })).toBe(
      'status delivered, totalCents 4200',
    );
    expect(resultSummary(null)).toBe('');
    expect(resultSummary('x'.repeat(200)).length).toBe(80);
    expect(shorten('a\n  b')).toBe('a b');
  });
});
