#!/usr/bin/env node
/**
 * Renders synthetic, anti-aliased test images as PNG files (no dependencies).
 *
 *   node scripts/generate-samples.mjs [outDir]   (default: samples/)
 *
 * bw-logo.png           black mark on white
 * color-logo.png        flat multicolour logo on white
 * transparent-icon.png  multicolour icon on a fully transparent background
 * illustration.png      detailed scene with gradients and many shapes
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};

function encodePng(width, height, rgba) {
    const chunk = (type, data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([len, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y += 1) {
        raw[y * (width * 4 + 1)] = 0;
        Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/* Shapes are signed-distance-free inside tests; supersampling gives the anti-aliasing. */
const circle = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const ring = (cx, cy, r1, r2) => (x, y) => {
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    return d <= r2 * r2 && d >= r1 * r1;
};
const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const roundRect = (x0, y0, x1, y1, r) => (x, y) => {
    if (!rect(x0, y0, x1, y1)(x, y)) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const polygon = (points) => (x, y) => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
};
const not = (a, b) => (x, y) => a(x, y) && !b(x, y);
const hex = (h, a = 255) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];

/** layers: [{ shape, color | shade(x, y) }], painted in order over `background`. */
function render(width, height, background, layers, ss = 4) {
    const out = new Uint8ClampedArray(width * height * 4);
    for (let py = 0; py < height; py += 1) {
        for (let px = 0; px < width; px += 1) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            for (let sy = 0; sy < ss; sy += 1) {
                for (let sx = 0; sx < ss; sx += 1) {
                    const x = px + (sx + 0.5) / ss;
                    const y = py + (sy + 0.5) / ss;
                    let c = typeof background === 'function' ? background(x, y) : background;
                    for (const layer of layers) {
                        if (layer.shape(x, y)) c = layer.shade ? layer.shade(x, y) : layer.color;
                    }
                    const alpha = c[3] / 255;
                    r += c[0] * alpha;
                    g += c[1] * alpha;
                    b += c[2] * alpha;
                    a += alpha;
                }
            }
            const i = (py * width + px) * 4;
            out[i] = a ? r / a : 0;
            out[i + 1] = a ? g / a : 0;
            out[i + 2] = a ? b / a : 0;
            out[i + 3] = (a / (ss * ss)) * 255;
        }
    }
    return out;
}

const mix = (c1, c2, t) => c1.map((v, i) => v + (c2[i] - v) * t);

function star(cx, cy, outer, inner, points = 5, rotation = -Math.PI / 2) {
    return polygon(
        Array.from({ length: points * 2 }, (_, i) => {
            const r = i % 2 ? inner : outer;
            const t = rotation + (i * Math.PI) / points;
            return [cx + r * Math.cos(t), cy + r * Math.sin(t)];
        }),
    );
}

export const SAMPLES = {
    'bw-logo.png': () => {
        const [w, h] = [480, 480];
        const black = hex('#111111');
        return {
            width: w,
            height: h,
            pixels: render(w, h, hex('#ffffff'), [
                { shape: ring(240, 240, 150, 200), color: black },
                { shape: star(240, 240, 120, 50), color: black },
                { shape: rect(90, 400, 390, 430), color: black },
            ]),
        };
    },
    'color-logo.png': () => {
        const [w, h] = [600, 400];
        return {
            width: w,
            height: h,
            pixels: render(w, h, hex('#ffffff'), [
                { shape: roundRect(40, 60, 300, 340, 48), color: hex('#6d4aff') },
                { shape: circle(170, 200, 80), color: hex('#ffc93c') },
                { shape: polygon([[150, 160], [150, 240], [215, 200]]), color: hex('#e8364f') },
                { shape: roundRect(330, 90, 560, 150, 20), color: hex('#1fb57a') },
                { shape: roundRect(330, 175, 520, 225, 20), color: hex('#1b8ef2') },
                { shape: roundRect(330, 250, 480, 300, 20), color: hex('#ff7a1a') },
            ]),
        };
    },
    'transparent-icon.png': () => {
        const [w, h] = [512, 512];
        return {
            width: w,
            height: h,
            pixels: render(w, h, [0, 0, 0, 0], [
                { shape: circle(256, 256, 200), color: hex('#2563eb') },
                { shape: not(circle(256, 256, 150), circle(256, 256, 95)), color: hex('#ffffff') },
                { shape: star(256, 256, 85, 38), color: hex('#facc15') },
                { shape: circle(420, 110, 60), color: hex('#ef4444') },
            ]),
        };
    },
    'illustration.png': () => {
        const [w, h] = [960, 640];
        const sky = (x, y) => mix(hex('#1e1b4b'), hex('#f97316'), Math.min(1, y / 420));
        const layers = [
            { shape: circle(700, 330, 110), shade: (x, y) => mix(hex('#fde68a'), hex('#fb923c'), (y - 220) / 220) },
            {
                shape: polygon([[0, 470], [140, 300], [260, 420], [400, 260], [560, 440], [700, 330], [960, 470], [960, 640], [0, 640]]),
                shade: (x, y) => mix(hex('#4c1d95'), hex('#1e1b4b'), (y - 260) / 380),
            },
            {
                shape: polygon([[0, 540], [200, 430], [380, 520], [620, 410], [820, 500], [960, 450], [960, 640], [0, 640]]),
                shade: (x, y) => mix(hex('#312e81'), hex('#0f172a'), (y - 410) / 230),
            },
        ];
        for (let i = 0; i < 26; i += 1) {
            const x = 30 + i * 36 + ((i * 37) % 13);
            const base = 560 + ((i * 53) % 40);
            const height = 60 + ((i * 29) % 70);
            layers.push({ shape: polygon([[x, base - height], [x - 18, base], [x + 18, base]]), color: hex(i % 2 ? '#064e3b' : '#065f46') });
            layers.push({ shape: rect(x - 3, base, x + 3, base + 14), color: hex('#3f2a14') });
        }
        for (let i = 0; i < 40; i += 1) {
            const x = (i * 97) % w;
            const y = (i * 61) % 200;
            layers.push({ shape: circle(x, y, 1.5 + (i % 3)), color: hex('#fefce8') });
        }
        for (const [cx, cy] of [[180, 120], [420, 90], [560, 170]]) {
            const cloud = (x, y) => [[0, 0, 34], [32, -10, 28], [62, 0, 30], [30, 12, 30]].some(([dx, dy, r]) => circle(cx + dx, cy + dy, r)(x, y));
            layers.push({ shape: cloud, shade: (x, y) => mix(hex('#fdf4ff'), hex('#f0abfc'), (y - cy + 40) / 80) });
        }
        return { width: w, height: h, pixels: render(w, h, sky, layers, 3) };
    },
};

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
if (isMain) {
    const outDir = resolve(process.argv[2] ?? 'samples');
    mkdirSync(outDir, { recursive: true });
    for (const [name, make] of Object.entries(SAMPLES)) {
        const { width, height, pixels } = make();
        writeFileSync(join(outDir, name), encodePng(width, height, pixels));
        console.log(`wrote ${join(outDir, name)} (${width}×${height})`);
    }
}
