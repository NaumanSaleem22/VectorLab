/**
 * Runs preprocessing, VTracer (WebAssembly) and SVGO off the main thread.
 *
 * Protocol (main → worker): { type: 'vectorize', id, pixels: ArrayBuffer, width, height, settings, output }
 * Protocol (worker → main): { type: 'stage', id, stage } | { type: 'result', id, ... } | { type: 'error', id, code, detail }
 */
import initEngine, { vectorize_rgba as vectorizeRgba } from '../wasm/vtracer/vtracer_wasm.js';
import wasmUrl from '../wasm/vtracer/vtracer_wasm_bg.wasm?url';
import { preprocess } from './image-preprocessor.js';
import { toEngineOptions } from './settings.js';
import { finalizeSvg, optimizeSvg } from './svg-optimizer.js';
import { snapSvgFills } from './palette.js';
import { traceLayers } from './layered-trace.js';

let enginePromise = null;

function ensureEngine() {
    enginePromise ??= initEngine({ module_or_path: wasmUrl }).catch((error) => {
        enginePromise = null;
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: 'engine-init' });
    });
    return enginePromise;
}

function classify(error) {
    const text = String(error?.message ?? error);
    if (/memory|allocation|out of bounds|Maximum call stack/i.test(text)) return 'memory';
    return 'trace';
}

async function vectorize({ id, pixels, width, height, settings, output }) {
    const stage = (name) => self.postMessage({ type: 'stage', id, stage: name });
    const timings = {};
    let mark = performance.now();
    const lap = (name) => {
        const now = performance.now();
        timings[name] = now - mark;
        mark = now;
    };

    stage('init');
    await ensureEngine();
    lap('init');

    stage('preprocess');
    const scale = width / output.width;
    const prepared = preprocess({ data: new Uint8ClampedArray(pixels), width, height }, settings, scale);
    lap('preprocess');

    stage('trace');
    const engineOptions = toEngineOptions(settings, scale);
    let traced;
    try {
        const { data, width: w, height: h } = prepared.image;
        traced =
            settings.hierarchical === 'layered' && prepared.palette
                ? traceLayers(prepared.image, prepared.palette, vectorizeRgba, engineOptions, Math.max(2, Math.round(scale)))
                : vectorizeRgba(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), w, h, engineOptions);
    } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: classify(error) });
    }
    lap('trace');

    stage('generate');
    const needsBackgroundRect = settings.colorMode === 'bw' && (settings.background === 'white' || settings.background === 'custom');
    const svg = finalizeSvg(snapSvgFills(traced, prepared.palette), {
        traceWidth: prepared.image.width,
        traceHeight: prepared.image.height,
        offsetY: prepared.offsetY,
        outputWidth: output.width,
        outputHeight: output.height,
        backgroundColor: needsBackgroundRect ? (settings.background === 'white' ? '#ffffff' : settings.backgroundColor) : null,
    });
    lap('generate');

    stage('optimize');
    let optimized = null;
    let optimizeError = null;
    try {
        optimized = optimizeSvg(svg, { pathPrecision: settings.pathPrecision });
    } catch (error) {
        console.error('[VectorLab] SVGO optimization failed', error);
        optimizeError = String(error?.message ?? error);
    }
    lap('optimize');

    self.postMessage({
        type: 'result',
        id,
        svg,
        optimized,
        optimizeError,
        warnings: prepared.warnings,
        paletteSize: prepared.palette?.length ?? 0,
        engineOptions,
        trace: { width: prepared.image.width, height: prepared.image.height - prepared.offsetY * 2 },
        timings,
    });
}

self.addEventListener('message', async (event) => {
    const message = event.data;
    if (message?.type !== 'vectorize') return;
    try {
        await vectorize(message);
    } catch (error) {
        console.error('[VectorLab] Vectorization failed', error);
        self.postMessage({
            type: 'error',
            id: message.id,
            code: error?.code ?? 'trace',
            detail: String(error?.message ?? error),
        });
    }
});
