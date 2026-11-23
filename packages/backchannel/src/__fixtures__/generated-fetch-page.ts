import { createProbeClientWithFetch } from './probe-client/fetch-operation-client.generated.ts';

export const client = createProbeClientWithFetch({ baseUrl: '/api' });
