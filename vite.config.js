import { defineConfig } from 'vite';

export default defineConfig({
    base: './',
    worker: {
        format: 'es',
    },
    build: {
        target: 'es2022',
        assetsInlineLimit: (file) => (file.endsWith('.wasm') ? false : undefined),
    },
    server: {
        port: 5173,
    },
    preview: {
        port: 4173,
    },
});
