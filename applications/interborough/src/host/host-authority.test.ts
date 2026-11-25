import { expect, test } from 'bun:test';
import { createHostAuthority } from './host-authority.ts';

test('a shared-only workspace does not fall back to the local owner', async () => {
  const authority = await createHostAuthority({
    workspaceId: 'workspace',
    resolveMembership: async () => {
      throw new Error('no credential was verified');
    },
  });
  const result = await authority.authenticate(new Request('http://localhost/'));
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).status).toBe(401);
});
