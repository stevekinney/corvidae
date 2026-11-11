import { expect } from 'bun:test';

import {
  CLI_AUTHORITY_DISPATCH,
  CLI_DYNAMIC_DISPATCH,
  CLI_OPERATION_MAPPINGS,
  executeCli,
  type CliClientDependencies,
} from './cli-client.ts';

function matchesRoute(actual: string, expected: string): boolean {
  const actualParts = actual.split('/');
  const expectedParts = expected.split('/');
  return (
    actualParts.length === expectedParts.length &&
    expectedParts.every((part, index) =>
      part.startsWith(':') ? actualParts[index] !== '' : part === actualParts[index],
    )
  );
}

/** Run existing client scenarios while independently checking every emitted wire dispatch. */
export async function executeCliWithDispatchAssertions(
  arguments_: readonly string[],
  dependencies: CliClientDependencies = {},
) {
  const observed: string[] = [];
  const result = await executeCli(arguments_, {
    ...dependencies,
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      let descriptor = `${init?.method ?? (input instanceof Request ? input.method : 'GET')} ${url.pathname}`;
      if (typeof init?.body === 'string' && url.pathname.endsWith('/jsonrpc')) {
        const body: unknown = JSON.parse(init.body);
        if (
          typeof body === 'object' &&
          body !== null &&
          'method' in body &&
          typeof body.method === 'string'
        )
          descriptor = body.method;
      }
      observed.push(descriptor);
      return (dependencies.fetch ?? fetch)(input, init);
    },
  });
  assertCliDispatches(arguments_, observed);
  return result;
}

/** Assert captured wire calls after execution, so client error handling cannot swallow failures. */
export function assertCliDispatches(
  arguments_: readonly string[],
  observed: readonly string[],
): void {
  const command = arguments_[0];
  const mappings: readonly string[] =
    Object.entries(CLI_OPERATION_MAPPINGS).find(([name]) => name === command)?.[1] ?? [];
  for (const descriptor of observed) {
    // Every remote command resolves authority before dispatching its own operation.
    if (descriptor === CLI_AUTHORITY_DISPATCH) continue;
    // api call deliberately selects arbitrary discovered RPC operations at runtime.
    if (command === 'api' && arguments_[1] === 'call' && !descriptor.includes(' ')) {
      expect(CLI_DYNAMIC_DISPATCH.api).not.toBe('');
      continue;
    }
    expect(
      mappings.some((mapping) => matchesRoute(descriptor, mapping)),
      `${command}: undocumented wire dispatch ${descriptor}`,
    ).toBe(true);
  }
}
