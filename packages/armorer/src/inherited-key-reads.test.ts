/**
 * Regression tests for one defect class: a plain-object lookup answering for a name every object
 * inherits. Each case uses `constructor` as the key, so a read that skips `Object.hasOwn` finds
 * `Object` and treats it as a declared entry.
 *
 * The check in `scripts/check-inherited-key-reads.ts` keeps new reads of this kind out of `src`.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  metadataContains,
  metadataEquals,
  metadataHasKeys,
  metadataInRange,
  metadataStartsWith,
} from './core/registry/filters';
import { scoreTagMatches } from './core/registry/ranking-utilities';
import { schemasLooselyMatch } from './core/schema-utilities';
import { projectExecutionSnapshot } from './execution-context';
import { fieldKey } from './idempotency/key-generators';
import { createToolboxFromOpenAPI, type OpenAPISpec } from './integrations/openapi';
import { renderToolSummary } from './tool-summary';
import { matchesArgumentConstraints } from './toolbox-grants';

describe('names that every object inherits', () => {
  it('is not a metadata key a tool declares', () => {
    const metadata = { region: 'eu', rank: 3 };
    expect(metadataHasKeys(metadata, ['constructor'])).toBe(false);
    expect(metadataEquals(metadata, { constructor: undefined })).toBe(true);
    expect(metadataEquals(metadata, { toString: undefined })).toBe(true);
    expect(metadataContains(metadata, { constructor: 'eu' })).toBe(false);
    expect(metadataStartsWith(metadata, { constructor: 'e' })).toBe(false);
    expect(metadataInRange(metadata, { constructor: { min: 0 } })).toBe(false);
  });

  it('weighs a tag named constructor as an unweighted tag', () => {
    expect(scoreTagMatches(['constructor'], 2, { urgent: 5 })).toBe(2);
    expect(scoreTagMatches(['urgent'], 2, { urgent: 5 })).toBe(10);
  });

  it('is not a key the target schema declares', () => {
    const target = z.object({ name: z.string() });
    expect(schemasLooselyMatch(target, z.object({ name: z.string() }))).toBe(true);
    expect(schemasLooselyMatch(target, z.object({ constructor: z.string() }))).toBe(false);
  });

  it('is an empty field to an idempotency key, not Object', () => {
    expect(fieldKey('constructor')({ id: 1 })).toBe(fieldKey('missing')({ id: 1 }));
  });

  it('is not a summary format', () => {
    const metadata = { summary: 'Order {orderId:constructor}' };
    expect(renderToolSummary(metadata, { orderId: 1 })).toBeUndefined();
  });

  it('is not an argument a call supplied, so a constraint on it fails', () => {
    expect(matchesArgumentConstraints({ constructor: undefined }, { id: 1 })).toBe(true);
    expect(matchesArgumentConstraints({ toString: 'x' }, { id: 1 })).toBe(false);
  });

  it('is never a field an external projection exports', () => {
    const projection = projectExecutionSnapshot(
      JSON.parse('{"executionId":"e1","constructor":"leaked"}') as unknown,
      { audience: 'operator' },
    );
    expect(projection.data).toEqual({ executionId: 'e1' });
  });

  it('is not a step of a local $ref in an OpenAPI document', () => {
    const spec: OpenAPISpec = {
      openapi: '3.0.0',
      paths: {
        '/pets': {
          post: {
            operationId: 'addPet',
            requestBody: { $ref: '#/constructor' },
          },
        },
      },
    };
    expect(() => createToolboxFromOpenAPI(spec, { baseUrl: 'https://example.test' })).toThrow(
      /unresolved \$ref/,
    );
  });
});
