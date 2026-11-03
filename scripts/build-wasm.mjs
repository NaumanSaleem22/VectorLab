#!/usr/bin/env node
/**
 * Rebuilds the browser VTracer engine in src/wasm/vtracer from the official source.
 *
 * VTracer's `nodejs/` crate is a plain wasm-bindgen library (`vectorize_rgba`,
 * `vectorize_bytes`) with no Node or DOM APIs. Upstream builds it with
 * `--target nodejs`; we build the same crate with `--target web` so it loads as
 * an ES module in browsers and module workers.
 *
 * Requirements: git, Rust with the wasm32-unknown-unknown target, and
 * wasm-bindgen-cli matching the crate's wasm-bindgen version (see README).
 *
 *   node scripts/build-wasm.mjs
 *   VTRACER_TOOLCHAIN=stable-x86_64-pc-windows-gnu node scripts/build-wasm.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VTRACER_REPO = 'https://github.com/visioncortex/vtracer.git';
const VTRACER_COMMIT = 'e71343fbcbf469b8a72a255030408a39939162eb';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(root, '.vtracer-src');
const crateDir = join(sourceDir, 'nodejs');
const outDir = join(root, 'src', 'wasm', 'vtracer');
const toolchain = process.env.VTRACER_TOOLCHAIN;

function run(cmd, args, cwd = root) {
    console.log(`\n$ ${cmd} ${args.join(' ')}`);
    execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

if (!existsSync(join(sourceDir, '.git'))) {
    run('git', ['clone', VTRACER_REPO, sourceDir]);
}
run('git', ['fetch', '--depth', '1', 'origin', VTRACER_COMMIT], sourceDir);
run('git', ['checkout', '--detach', VTRACER_COMMIT], sourceDir);

const cargoArgs = ['build', '--release', '--target', 'wasm32-unknown-unknown'];
run('cargo', toolchain ? [`+${toolchain}`, ...cargoArgs] : cargoArgs, crateDir);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
run('wasm-bindgen', [
    join(crateDir, 'target', 'wasm32-unknown-unknown', 'release', 'vtracer_wasm.wasm'),
    '--target', 'web',
    '--out-dir', outDir,
]);

writeFileSync(
    join(outDir, 'BUILD_INFO.txt'),
    `Built from ${VTRACER_REPO} @ ${VTRACER_COMMIT} (crate: nodejs/, wasm-bindgen --target web)\n`,
);
console.log(`\nVTracer WASM written to ${outDir}`);
