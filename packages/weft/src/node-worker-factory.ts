import { resolveObjectURL } from 'node:buffer';
import { Worker, type TransferListItem } from 'node:worker_threads';

import type { CreateWorker } from './workers/pool.ts';

class NodeWorkerAdapter extends EventTarget {
  readonly #worker: Worker;
  #terminationRequested = false;
  #failureReported = false;

  constructor(url: string | URL) {
    super();
    const entry = String(url);
    const source = entry.startsWith('blob:') ? resolveObjectURL(entry) : undefined;
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
      const entry = workerData.source
        ? workerData.source.text().then(source =>
            'data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
        : Promise.resolve(workerData.entry);
      entry.then(entry => import(entry)).then(() => {
        ready = true;
        for (const message of queuedMessages) deliver(message);
      }).catch(error => { throw error; });
    `,
      {
        eval: true,
        workerData: { entry, source },
      },
    );
    this.#worker.on('message', (data) => {
      this.dispatchEvent(new MessageEvent('message', { data }));
    });
    this.#worker.on('messageerror', (data) => {
      this.dispatchEvent(new MessageEvent('messageerror', { data }));
    });
    this.#worker.on('error', (error) => {
      this.#reportFailure(error);
    });
    this.#worker.on('exit', (code) => {
      if (!this.#terminationRequested) {
        this.#reportFailure(new Error(`Node worker exited unexpectedly with code ${code}`));
      }
      this.dispatchEvent(new Event('close'));
    });
  }

  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.#worker.postMessage(message, transfer as TransferListItem[] | undefined);
  }
  terminate(): Promise<number> {
    this.#terminationRequested = true;
    return this.#worker.terminate();
  }

  #reportFailure(error: Error): void {
    if (this.#failureReported) return;
    this.#failureReported = true;
    this.dispatchEvent(Object.assign(new Event('error'), { error, message: error.message }));
  }
}

/** Creates a Node worker-thread behind the Web Worker contract used by Weft. */
export const nodeWorkerFactory: CreateWorker = (url) => new NodeWorkerAdapter(url);
