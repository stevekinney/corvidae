import { expect, test } from 'bun:test';
import { inspectorArguments, inspectorRefusedUnauthorized } from './connector-smoke-inspector';

test('targets the configured resource and distinguishes refusal from unrelated failures', () => {
  expect(inspectorArguments('https://example.com/api/mcp')).toContain(
    'https://example.com/api/mcp',
  );
  const response = '{"error":{"code":"auth_required","message":"Error POSTing to endpoint: "}}';
  expect(inspectorRefusedUnauthorized(3, response, false)).toBe(true);
  expect(inspectorRefusedUnauthorized(3, response, true)).toBe(false);
  expect(inspectorRefusedUnauthorized(3, 'no stored credentials', false)).toBe(false);
  expect(inspectorRefusedUnauthorized(0, response, false)).toBe(false);
});
