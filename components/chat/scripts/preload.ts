import { registerGlobalCleanup, setupHappyDom, sveltePlugin } from '@corvidae/testing';
import { plugin } from 'bun';
import { afterEach } from 'bun:test';

setupHappyDom();
await plugin(sveltePlugin({ generate: 'client' }));
await registerGlobalCleanup(afterEach);
