import {
  createRateLimiter,
  createRotatingApiKeyStore,
  type ApiKeyStore,
  type RateLimitStore,
} from '../index.ts';

const keyStore: ApiKeyStore = createRotatingApiKeyStore();
const rateLimitStore: RateLimitStore = createRateLimiter({ maxRequests: 1, windowMs: 1_000 });

void keyStore.count().then((count) => count.toFixed());
void Promise.resolve(rateLimitStore.check('caller')).then((decision) => decision.allowed);
