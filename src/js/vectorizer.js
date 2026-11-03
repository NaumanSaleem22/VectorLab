import { UserFacingError } from './utils.js';

const ERROR_MESSAGES = {
    'engine-init': 'The vectorization engine could not be loaded. Please reload the page and try again.',
    memory: 'The image is too complex to vectorize with the available memory. Try a smaller processing size, fewer colours or a lower detail level.',
    trace: 'The image could not be vectorized with these settings. Try a different preset or adjust the settings.',
    crash: 'The vectorization engine stopped unexpectedly. This usually means the browser ran out of memory — try a smaller processing size.',
};

export class CancelledError extends Error {
    constructor() {
        super('Conversion cancelled');
        this.name = 'CancelledError';
    }
}

/**
 * Owns the vectorization worker. The worker (and the WASM engine inside it)
 * is created lazily on the first job, and terminated on cancel or crash so a
 * stuck or corrupted engine never serves another job.
 */
export class Vectorizer {
    #worker = null;
    #job = null;
    #nextId = 1;

    get busy() {
        return this.#job !== null;
    }

    #ensureWorker() {
        if (this.#worker) return this.#worker;
        const worker = new Worker(new URL('./vectorization-worker.js', import.meta.url), { type: 'module' });
        worker.addEventListener('message', (event) => this.#onMessage(event.data));
        worker.addEventListener('error', (event) => {
            console.error('[VectorLab] Worker error', event.message ?? event);
            event.preventDefault?.();
            this.#fail('crash', event.message);
        });
        worker.addEventListener('messageerror', () => this.#fail('crash', 'messageerror'));
        this.#worker = worker;
        return worker;
    }

    #onMessage(message) {
        const job = this.#job;
        if (!job || message.id !== job.id) return;
        if (message.type === 'stage') {
            job.onStage?.(message.stage);
        } else if (message.type === 'result') {
            this.#job = null;
            job.resolve(message);
        } else if (message.type === 'error') {
            // A failed WASM call may leave the engine in an undefined state, so start fresh next time.
            this.#terminate();
            this.#fail(message.code, message.detail, job);
        }
    }

    #fail(code, detail, job = this.#job) {
        if (!job) return;
        this.#job = null;
        if (code === 'crash') this.#terminate();
        const error = new UserFacingError(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.trace, detail);
        error.code = code;
        job.reject(error);
    }

    #terminate() {
        this.#worker?.terminate();
        this.#worker = null;
    }

    /**
     * @param {{ pixels: Uint8ClampedArray, width: number, height: number }} image  pixel buffer, transferred to the worker
     */
    vectorize(image, settings, output, onStage) {
        if (this.#job) return Promise.reject(new Error('A conversion is already running.'));
        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            this.#job = { id, resolve, reject, onStage };
            const buffer = image.pixels.buffer;
            this.#ensureWorker().postMessage(
                { type: 'vectorize', id, pixels: buffer, width: image.width, height: image.height, settings, output },
                [buffer],
            );
        });
    }

    cancel() {
        const job = this.#job;
        if (!job) return;
        this.#job = null;
        this.#terminate();
        job.reject(new CancelledError());
    }

    dispose() {
        this.cancel();
        this.#terminate();
    }
}
