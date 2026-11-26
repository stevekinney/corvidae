import { Worker } from 'node:worker_threads';

import type { CreateWorker } from './workers/pool.ts';

class NodeWorkerAdapter extends EventTarget {
  readonly #worker: Worker;

  constructor(url: string | URL) {
    super();
    this.#worker = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const scope = new EventTarget();
      let onmessage = null;
      Object.defineProperty(scope, 'onmessage', { get: () => onmessage, set: value => { onmessage = value; } });
      globalThis.self = scope;
      scope.postMessage = message => parentPort.postMessage(message);
      globalThis.postMessage = scope.postMessage;
      const queuedMessages = [];
      let ready = false;
      const deliver = data => {
        const event = new MessageEvent('message', { data });
        scope.dispatchEvent(event);
        onmessage?.(event);
      };
      parentPort.on('message', data => {
        if (!ready) queuedMessages.push(data);
        else deliver(data);
      });
      import(workerData.entry).then(() => {
        ready = true;
        for (const message of queuedMessages) deliver(message);
      }).catch(error => { throw error; });
    `,
      {
        eval: true,
        workerData: { entry: String(url) },
      },
    );
    this.#worker.on('message', (data) => {
      this.dispatchEvent(new MessageEvent('message', { data }));
    });
    this.#worker.on('messageerror', (data) => {
      this.dispatchEvent(new MessageEvent('messageerror', { data }));
    });
    this.#worker.on('error', (error) => {
      this.dispatchEvent(Object.assign(new Event('error'), { error, message: error.message }));
    });
    this.#worker.on('exit', () => this.dispatchEvent(new Event('close')));
  }

  postMessage(message: unknown): void {
    this.#worker.postMessage(message);
  }
  terminate(): Promise<number> {
    return this.#worker.terminate();
  }
}

/** Creates a Node worker-thread behind the Web Worker contract used by Weft. */
export const nodeWorkerFactory: CreateWorker = (url) => new NodeWorkerAdapter(url);
