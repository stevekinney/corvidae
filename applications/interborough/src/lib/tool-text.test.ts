import { describe, expect, test } from 'bun:test';

import {
  approvalQuestion,
  argumentLine,
  declaredSummary,
  policyReasonOf,
  reasonSaysAlways,
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

  // COR-2438: the owner saw `Tool "bureau:discover-agents" (read-only tier) requires approval
  // (mode: always)?` as the card's title, because the row carrying the reason did not say the same
  // sentence (or had not been read) and the comparison was exact.
  const REASON = 'Tool "bureau:discover-agents" (read-only tier) requires approval (mode: always).';
  test('the policy reason is never a summary, whatever the reason it is compared with', () => {
    expect(declaredSummary(REASON, undefined)).toBeUndefined();
    expect(declaredSummary(REASON, 'This tool call needs your approval.')).toBeUndefined();
    expect(declaredSummary(REASON)).toBeUndefined();
    expect(
      declaredSummary(
        'Tool "issue-refund" (dangerous tier) is denied by approval policy (mode: x).',
      ),
    ).toBeUndefined();
  });

  test('a policy reason naming the tool in its provider form is not a summary either', () => {
    expect(
      declaredSummary(
        'Tool "bureau__discover-agents" (read-only tier) requires approval (mode: always)',
      ),
    ).toBeUndefined();
    expect(
      declaredSummary('Look up order 1001', undefined, ' Look up order 1001 '),
    ).toBeUndefined();
    expect(declaredSummary('Look up order 1001', 'requires approval')).toBe('Look up order 1001');
  });
});

describe('policyReasonOf', () => {
  test('is the first candidate that is a policy sentence, else the first one given', () => {
    expect(policyReasonOf(undefined, 'Approval needed', REASON_ALWAYS)).toBe(REASON_ALWAYS);
    expect(policyReasonOf(undefined, '  ', 'Approval needed')).toBe('Approval needed');
    expect(policyReasonOf(undefined, undefined)).toBeUndefined();
  });

  test('says Always for an approval whose only copy of the reason is its message', () => {
    expect(reasonSaysAlways(policyReasonOf(undefined, undefined, REASON_ALWAYS))).toBe(true);
  });
});

const REASON_ALWAYS =
  'Tool "bureau:discover-agents" (read-only tier) requires approval (mode: always).';

describe('reasonSaysAlways', () => {
  test('is true for the policy sentence of a tool set to Always, and for nothing else', () => {
    expect(
      reasonSaysAlways('Tool "issue-refund" (dangerous tier) requires approval (mode: always).'),
    ).toBe(true);
    expect(
      reasonSaysAlways('Tool "create-issue" (mutating tier) requires approval (mode: on-changes).'),
    ).toBe(false);
    expect(reasonSaysAlways('Always ask me.')).toBe(false);
    expect(reasonSaysAlways(undefined)).toBe(false);
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
      'Status delivered, Total cents 4200',
    );
    expect(resultSummary({ nested: { rawKey: 1 }, signalName: 'environment' })).toBe(
      'Signal name environment',
    );
    expect(resultSummary(null)).toBe('');
    expect(resultSummary('x'.repeat(200)).length).toBe(80);
    expect(shorten('a\n  b')).toBe('a b');
  });

  test('summarizes a question and a refund without repeating their payload fields', () => {
    expect(
      resultSummary(
        { parked: true, signalName: 'environment', prompt: 'Where should it go?' },
        'requestHumanInput',
      ),
    ).toBe('Question asked');
    expect(resultSummary({ orderId: '4472', refundedCents: 1850 }, 'issue-refund')).toBe(
      '$18.50 refunded',
    );
  });
});
