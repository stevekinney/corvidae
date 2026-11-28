import { expect, test } from 'bun:test';
import {
  orderMetadataResults,
  partitionComponents,
} from './generate-component-metadata-parallel.ts';

test('partitions components into two disjoint ordered batches', () => {
  const components = ['a', 'b', 'c', 'd', 'e'];
  expect(partitionComponents(components)).toEqual([
    ['a', 'c', 'e'],
    ['b', 'd'],
  ]);
});

test('returns results in source order and refuses missing or duplicate components', () => {
  const expected = ['a', 'b'];
  const a = { name: 'a', schema: {}, variables: [] };
  const b = { name: 'b', schema: {}, variables: [] };
  expect(orderMetadataResults(expected, [b, a])).toEqual([a, b]);
  expect(() => orderMetadataResults(expected, [a, a])).toThrow();
  expect(() => orderMetadataResults(expected, [a])).toThrow();
});
