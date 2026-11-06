import {
  openTemporaryBungalow,
  parseSecretReference,
  SecretProviderError,
  type Bungalow,
  type ConfigurationWriteCondition,
  type PrepareSecretInput,
  type SecretOperationTransition,
  type SecretProvider,
} from '@lostgradient/bungalow';
import type { SecretHome } from './workspace-secrets.ts';

/** External fixture storage outlives all application clients created against its HTTP endpoint. */
export async function secretService() {
  const homes = [
    await openTemporaryBungalow({ name: 'secret-service' }),
    await openTemporaryBungalow({ name: 'secret-service' }),
  ];
  let valueReads = 0;
  let configurationWrites = 0;
  let loseAcknowledgement = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const token = request.headers.get('authorization');
      const home = homes.find((candidate) => candidate.workspaceId === token);
      if (home === undefined) return new Response(null, { status: 403 });
      const { method, arguments: arguments_ } = (await request.json()) as {
        method: string;
        arguments: unknown[];
      };
      try {
        let value: unknown;
        switch (method) {
          case 'readConfiguration':
            value = await home.readConfiguration();
            break;
          case 'writeConfiguration':
            configurationWrites++;
            value = await home.writeConfiguration(
              arguments_[0] as string,
              arguments_[1] as ConfigurationWriteCondition,
            );
            if (loseAcknowledgement) {
              loseAcknowledgement = false;
              return new Response(null, { status: 503 });
            }
            break;
          case 'readLegacy':
            valueReads++;
            value = await home.secretProvider.readLegacy(arguments_[0] as string);
            break;
          case 'readVersion':
            valueReads++;
            value = await home.secretProvider.readVersion(arguments_[0] as string);
            break;
          case 'prepare':
            value = await home.secretProvider.prepare(arguments_[0] as PrepareSecretInput);
            break;
          case 'getOperation':
            value = await home.secretProvider.getOperation(arguments_[0] as string);
            break;
          case 'listOperations':
            value = await home.secretProvider.listOperations();
            break;
          case 'transitionOperation':
            value = await home.secretProvider.transitionOperation(
              arguments_[0] as string,
              arguments_[1] as SecretOperationTransition,
            );
            break;
          case 'reclaim':
            value = await home.secretProvider.reclaim(arguments_[0] as string);
            break;
          default:
            return new Response(null, { status: 400 });
        }
        return Response.json({ value });
      } catch (error) {
        return Response.json(
          { code: error instanceof SecretProviderError ? error.code : 'unavailable' },
          { status: 409 },
        );
      }
    },
  });
  function client(index = 0): SecretHome {
    const home = homes[index] as Bungalow;
    return secretServiceClient(server.url, home.workspaceId);
  }
  return {
    client,
    endpoint: server.url,
    valueReads: () => valueReads,
    configurationWrites: () => configurationWrites,
    loseNextAcknowledgement: () => {
      loseAcknowledgement = true;
    },
    async [Symbol.asyncDispose]() {
      await server.stop(true);
      for (const home of homes) home.close();
    },
  };
}

/** Reconnect an independent fixture process to the external secret service. */
export function secretServiceClient(endpoint: URL, workspaceId: string): SecretHome {
  async function call<Result>(method: string, ...arguments_: unknown[]): Promise<Result> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: workspaceId, 'content-type': 'application/json' },
      body: JSON.stringify({ method, arguments: arguments_ }),
    });
    const result = (await response.json()) as {
      value: Result;
      code?: SecretProviderError['code'];
    };
    if (!response.ok)
      throw new SecretProviderError(
        result.code ?? 'unavailable',
        'The fixture provider refused the operation.',
      );
    return result.value;
  }
  const provider: SecretProvider = {
    workspaceId,
    capabilities: { read: true, prepare: true, transitions: true },
    readLegacy: (key) => call('readLegacy', key),
    readVersion: (reference) => {
      const parsed = parseSecretReference(reference, workspaceId);
      return call('readVersion', parsed.serialized);
    },
    prepare: (input) => call('prepare', input),
    getOperation: (id) => call('getOperation', id),
    listOperations: () => call('listOperations'),
    transitionOperation: (id, transition) => call('transitionOperation', id, transition),
    reclaim: (reference) =>
      call('reclaim', parseSecretReference(reference, workspaceId).serialized),
  };
  return {
    workspaceId,
    secretProvider: provider,
    configurationLocation: 'fixture-service',
    configurationWriteCapability: 'writable',
    readConfiguration: () => call('readConfiguration'),
    writeConfiguration: (text, condition) => call('writeConfiguration', text, condition),
  };
}
