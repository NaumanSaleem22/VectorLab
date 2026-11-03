#!/usr/bin/env node
/**
 * Proves the bundled VTracer WASM build produces genuine vector output.
 *
 *   node scripts/verify-engine.mjs [image files...] [--out dir]
 *
 * Without arguments it traces the synthetic samples from generate-samples.mjs
 * via `vectorize_rgba` (the same entry point the browser worker uses).
 * Image files are decoded by VTracer itself via `vectorize_bytes`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { initSync, vectorize_bytes as vectorizeBytes, vectorize_rgba as vectorizeRgba } from '../src/wasm/vtracer/vtracer_wasm.js';
import { SAMPLES } from './generate-samples.mjs';

const wasmPath = new URL('../src/wasm/vtracer/vtracer_wasm_bg.wasm', import.meta.url);
initSync({ module: readFileSync(wasmPath) });

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? resolve(args.splice(outIndex, 2)[1]) : null;
if (outDir) mkdirSync(outDir, { recursive: true });

function inspect(name, svg, ms) {
    const paths = (svg.match(/<path\b/g) ?? []).length;
    const fills = new Set(svg.match(/fill="#[0-9a-fA-F]{3,6}"/g) ?? []).size;
    const raster = /<image\b|data:image\//i.test(svg);
    const ok = paths > 0 && !raster && svg.includes('<svg');
    console.log(
        `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(24)} paths=${String(paths).padStart(6)}  colours=${String(fills).padStart(4)}  ` +
            `size=${(svg.length / 1024).toFixed(1).padStart(8)} KB  raster=${raster}  ${ms.toFixed(0)} ms`,
    );
    if (outDir) writeFileSync(join(outDir, name.replace(/\.\w+$/, '.svg')), svg);
    return ok;
}

let failures = 0;
if (args.length === 0) {
    for (const [name, make] of Object.entries(SAMPLES)) {
        const { width, height, pixels } = make();
        const options = name.startsWith('bw') ? { clustering: 'bw' } : { clustering: 'color-cluster' };
        const start = performance.now();
        const svg = vectorizeRgba(new Uint8Array(pixels.buffer), width, height, options);
        if (!inspect(name, svg, performance.now() - start)) failures += 1;
    }
} else {
    for (const file of args) {
        const start = performance.now();
        const svg = vectorizeBytes(readFileSync(file), { preset: 'photo' });
        if (!inspect(basename(file), svg, performance.now() - start)) failures += 1;
    }
}
process.exitCode = failures ? 1 : 0;
