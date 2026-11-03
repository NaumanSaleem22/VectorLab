/**
 * Pixel preprocessing that happens before tracing.
 *
 * VTracer only consumes RGBA pixels, so everything here is genuine pixel work
 * rather than an engine option: resizing, alpha handling, background removal,
 * background flattening and grayscale conversion. The functions operating on
 * `{ data, width, height }` are pure and run inside the vectorization worker;
 * `rasterize` needs a canvas and runs on the main thread.
 */
import { UserFacingError } from './utils.js';

const ALPHA_CUTOFF = 128;
const BACKGROUND_TOLERANCE = 42;
const MIN_BORDER_DOMINANCE = 0.4;
/** Mirrors VTracer's `KEYING_THRESHOLD` in crates/vtracer/src/frontend/keying.rs. */
const ENGINE_KEYING_THRESHOLD = 0.2;

export function processingSize(width, height, maxSide) {
    const longest = Math.max(width, height);
    if (!maxSide || longest <= maxSide) return { width, height, scaled: false };
    const scale = maxSide / longest;
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        scaled: true,
    };
}

/** Draws the decoded bitmap at processing size and returns unpremultiplied RGBA pixels. */
export function rasterize(bitmap, maxSide) {
    const size = processingSize(bitmap.width, bitmap.height, maxSide);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new UserFacingError('Your browser could not create a canvas to read the image pixels.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    let imageData;
    try {
        imageData = ctx.getImageData(0, 0, size.width, size.height);
    } catch (error) {
        throw new UserFacingError('The browser blocked access to the image pixels.', error);
    }
    canvas.width = 0;
    canvas.height = 0;
    return { data: imageData.data, width: size.width, height: size.height, scaled: size.scaled };
}

export function parseHexColor(hex) {
    const match = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
    if (!match) return { r: 255, g: 255, b: 255 };
    const value = parseInt(match[1], 16);
    return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

/** Snaps alpha to fully opaque or fully transparent, which is what VTracer's keying understands. */
function binarizeAlpha(data) {
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] < ALPHA_CUTOFF) {
            data[i - 3] = 0;
            data[i - 2] = 0;
            data[i - 1] = 0;
            data[i] = 0;
        } else {
            data[i] = 255;
        }
    }
}

function flattenOnto(data, color) {
    for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3] / 255;
        data[i] = Math.round(data[i] * a + color.r * (1 - a));
        data[i + 1] = Math.round(data[i + 1] * a + color.g * (1 - a));
        data[i + 2] = Math.round(data[i + 2] * a + color.b * (1 - a));
        data[i + 3] = 255;
    }
}

/** Finds the dominant opaque colour along the image border, or null when the border is not uniform enough. */
function detectBorderColor({ data, width, height }) {
    const buckets = new Map();
    let samples = 0;
    const sample = (x, y) => {
        const i = (y * width + x) * 4;
        if (data[i + 3] < ALPHA_CUTOFF) return;
        samples += 1;
        const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
        const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
        bucket.count += 1;
        bucket.r += data[i];
        bucket.g += data[i + 1];
        bucket.b += data[i + 2];
        buckets.set(key, bucket);
    };
    for (let x = 0; x < width; x += 1) {
        sample(x, 0);
        sample(x, height - 1);
    }
    for (let y = 1; y < height - 1; y += 1) {
        sample(0, y);
        sample(width - 1, y);
    }
    if (!samples) return null;
    let best = null;
    for (const bucket of buckets.values()) {
        if (!best || bucket.count > best.count) best = bucket;
    }
    if (best.count / samples < MIN_BORDER_DOMINANCE) return null;
    return {
        r: best.r / best.count,
        g: best.g / best.count,
        b: best.b / best.count,
    };
}

/**
 * Removes a uniform background by flood-filling from the image border:
 * only pixels similar to the border colour and connected to the edge become transparent,
 * so matching colours inside the artwork are kept.
 * Returns false when no uniform background could be detected.
 */
function removeBackground(image) {
    const { data, width, height } = image;
    const color = detectBorderColor(image);
    if (!color) return false;

    const toleranceSq = BACKGROUND_TOLERANCE * BACKGROUND_TOLERANCE;
    const matches = (p) => {
        const i = p * 4;
        if (data[i + 3] < ALPHA_CUTOFF) return true;
        const dr = data[i] - color.r;
        const dg = data[i + 1] - color.g;
        const db = data[i + 2] - color.b;
        return dr * dr + dg * dg + db * db <= toleranceSq;
    };

    const visited = new Uint8Array(width * height);
    const stack = new Int32Array(width * height);
    let top = 0;
    const push = (p) => {
        if (!visited[p] && matches(p)) {
            visited[p] = 1;
            stack[top++] = p;
        }
    };
    for (let x = 0; x < width; x += 1) {
        push(x);
        push((height - 1) * width + x);
    }
    for (let y = 0; y < height; y += 1) {
        push(y * width);
        push(y * width + width - 1);
    }
    while (top > 0) {
        const p = stack[--top];
        data[p * 4 + 3] = 0;
        const x = p % width;
        if (x > 0) push(p - 1);
        if (x < width - 1) push(p + 1);
        if (p >= width) push(p - width);
        if (p < width * (height - 1)) push(p + width);
    }
    return true;
}

function toGrayscale(data) {
    for (let i = 0; i < data.length; i += 4) {
        const y = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
        data[i] = y;
        data[i + 1] = y;
        data[i + 2] = y;
    }
}

/**
 * Quantizes each channel to `levels` steps. VTracer's clustering merges smooth
 * gradients into a single flat region; hard steps make it trace them as bands.
 */
function posterize(data, levels) {
    const step = 255 / (levels - 1);
    const table = new Uint8Array(256);
    for (let v = 0; v < 256; v += 1) table[v] = Math.round(Math.round(v / step) * step);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = table[data[i]];
        data[i + 1] = table[data[i + 1]];
        data[i + 2] = table[data[i + 2]];
    }
}

function hasTransparency(data) {
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] === 0) return true;
    }
    return false;
}

/** Port of VTracer's `should_key_image` sampling, so we know whether the engine will discard transparent pixels. */
function engineWillKey({ data, width, height }) {
    const threshold = Math.floor(width * 2 * ENGINE_KEYING_THRESHOLD);
    let transparent = 0;
    for (const y of [0, Math.floor(height / 4), Math.floor(height / 2), Math.floor((3 * height) / 4), height - 1]) {
        for (let x = 0; x < width; x += 1) {
            if (data[(y * width + x) * 4 + 3] === 0) transparent += 1;
            if (transparent >= threshold) return true;
        }
    }
    return false;
}

/**
 * VTracer only drops transparent pixels when its row sampling finds enough of them.
 * When an image has a little transparency that sampling would miss, add one transparent
 * row above and below so keying is guaranteed; the SVG viewBox then crops those rows away.
 */
function padForKeying(image) {
    if (!hasTransparency(image.data) || engineWillKey(image)) return { image, offsetY: 0 };
    const { width, height, data } = image;
    const padded = new Uint8ClampedArray(width * (height + 2) * 4);
    padded.set(data, width * 4);
    return { image: { data: padded, width, height: height + 2 }, offsetY: 1 };
}

/**
 * Applies colour-mode and background preprocessing in place.
 * Returns the pixels to trace and the vertical offset the SVG viewBox must apply.
 */
export function preprocess(image, settings) {
    const warnings = [];
    const isBinary = settings.colorMode === 'bw';
    const background = settings.background;

    if (background === 'remove' && !removeBackground(image)) {
        warnings.push('No uniform background colour was found along the image edges, so the background was kept.');
    }

    if (isBinary) {
        // The binary engine thresholds on RGB only, so transparent areas must read as light, not black.
        // A white or custom background is added afterwards as a vector rectangle behind the traced shapes.
        flattenOnto(image.data, { r: 255, g: 255, b: 255 });
        return { image, offsetY: 0, warnings };
    }

    if (background === 'white' || background === 'custom') {
        flattenOnto(image.data, background === 'white' ? { r: 255, g: 255, b: 255 } : parseHexColor(settings.backgroundColor));
    } else {
        binarizeAlpha(image.data);
    }

    if (settings.colorMode === 'grayscale') toGrayscale(image.data);
    if (settings.gradientBands > 0) posterize(image.data, settings.gradientBands);

    const keyed = padForKeying(image);
    return { image: keyed.image, offsetY: keyed.offsetY, warnings };
}
