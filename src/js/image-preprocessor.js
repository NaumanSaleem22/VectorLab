/**
 * Pixel preprocessing that happens before tracing.
 *
 * VTracer only consumes RGBA pixels, so everything here is genuine pixel work
 * rather than an engine option: resizing, alpha handling, background removal,
 * background flattening, grayscale, gradient bands and palette snapping. The functions operating on
 * `{ data, width, height }` are pure and run inside the vectorization worker;
 * `rasterize` needs a canvas and runs on the main thread.
 */
import { UserFacingError } from './utils.js';
import { AUTO_PALETTE_LIMIT, detectPalette, refineEdges, removeIslands, snapToPalette } from './palette.js';

const ALPHA_CUTOFF = 128;
const BACKGROUND_TOLERANCE = 42;
const MIN_BORDER_DOMINANCE = 0.4;
/** Mirrors VTracer's `KEYING_THRESHOLD` in crates/vtracer/src/frontend/keying.rs. */
const ENGINE_KEYING_THRESHOLD = 0.2;
/** Small images are enlarged to about this long side so thin details survive tracing. */
const UPSCALE_TARGET = 2400;
const MAX_UPSCALE = 6;
export const COLOR_COUNT_AUTO = 1;

/**
 * Edge refinement levels, in original-image pixels: `blur` is the Gaussian sigma
 * applied before colours are snapped (it irons out stair-steps and compression
 * ripples), `majority` the radius of the majority filter applied after snapping
 * (it removes leftover notches, bumps and stray pixels).
 */
const EDGE_REFINEMENT = [
    { blur: 0, majority: 0 },
    { blur: 0.45, majority: 0.5 },
    { blur: 0.7, majority: 1 },
    { blur: 1, majority: 1.5 },
];

/**
 * Size the image is traced at. Large images are scaled down to `maxSide`;
 * with `upscale`, small images are enlarged so that 1–3 px details (thin gaps,
 * sharp tips, small text) become wide enough for the tracer to keep.
 */
export function processingSize(width, height, maxSide, upscale = false) {
    const longest = Math.max(width, height);
    let scale = 1;
    if (maxSide && longest > maxSide) scale = maxSide / longest;
    else if (upscale && longest < UPSCALE_TARGET) scale = Math.min(MAX_UPSCALE, UPSCALE_TARGET / longest);
    if (scale === 1) return { width, height, scale, scaled: false };
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        scale,
        scaled: true,
    };
}

/** Draws the decoded bitmap at processing size and returns unpremultiplied RGBA pixels. */
export function rasterize(bitmap, maxSide, upscale = false) {
    const size = processingSize(bitmap.width, bitmap.height, maxSide, upscale);
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
    return { data: imageData.data, width: size.width, height: size.height, scale: size.scale };
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

/**
 * One horizontal + vertical box-blur pass over premultiplied RGBA, edges clamped.
 * Both passes walk memory row by row (the vertical one keeps running column sums),
 * which matters at the multi-megapixel sizes logos are traced at.
 */
function boxBlur(src, dst, width, height, r) {
    const span = 2 * r + 1;
    const stride = width * 4;
    for (let y = 0; y < height; y += 1) {
        const row = y * stride;
        let s0 = 0;
        let s1 = 0;
        let s2 = 0;
        let s3 = 0;
        for (let x = -r; x <= r; x += 1) {
            const i = row + Math.min(width - 1, Math.max(0, x)) * 4;
            s0 += src[i];
            s1 += src[i + 1];
            s2 += src[i + 2];
            s3 += src[i + 3];
        }
        for (let x = 0; x < width; x += 1) {
            const o = row + x * 4;
            dst[o] = s0 / span;
            dst[o + 1] = s1 / span;
            dst[o + 2] = s2 / span;
            dst[o + 3] = s3 / span;
            const add = row + Math.min(width - 1, x + r + 1) * 4;
            const drop = row + Math.max(0, x - r) * 4;
            s0 += src[add] - src[drop];
            s1 += src[add + 1] - src[drop + 1];
            s2 += src[add + 2] - src[drop + 2];
            s3 += src[add + 3] - src[drop + 3];
        }
    }
    const sums = new Float32Array(stride);
    for (let y = -r; y <= r; y += 1) {
        const row = Math.min(height - 1, Math.max(0, y)) * stride;
        for (let k = 0; k < stride; k += 1) sums[k] += dst[row + k];
    }
    for (let y = 0; y < height; y += 1) {
        const row = y * stride;
        const add = Math.min(height - 1, y + r + 1) * stride;
        const drop = Math.max(0, y - r) * stride;
        for (let k = 0; k < stride; k += 1) {
            src[row + k] = sums[k] / span;
            sums[k] += dst[add + k] - dst[drop + k];
        }
    }
}

/**
 * Approximate Gaussian blur (three box passes) in place. Colours are blurred
 * premultiplied by alpha so transparent pixels don't darken nearby edges.
 */
function gaussianBlur({ data, width, height }, sigma) {
    const r = Math.round(Math.sqrt(sigma * sigma + 0.25) - 0.5);
    if (r < 1) return;
    const buf = new Float32Array(data.length);
    for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3] / 255;
        buf[i] = data[i] * a;
        buf[i + 1] = data[i + 1] * a;
        buf[i + 2] = data[i + 2] * a;
        buf[i + 3] = data[i + 3];
    }
    const tmp = new Float32Array(data.length);
    for (let pass = 0; pass < 3; pass += 1) boxBlur(buf, tmp, width, height, r);
    for (let i = 0; i < data.length; i += 4) {
        const a = buf[i + 3];
        const k = a > 0 ? 255 / a : 0;
        data[i] = buf[i] * k;
        data[i + 1] = buf[i + 1] * k;
        data[i + 2] = buf[i + 2] * k;
        data[i + 3] = a;
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
 * Applies colour-mode, background and edge preprocessing in place.
 * `scale` is trace size ÷ original size, used to express refinement in original pixels.
 * Returns the pixels to trace and the vertical offset the SVG viewBox must apply.
 */
export function preprocess(image, settings, scale = 1) {
    const warnings = [];
    const isBinary = settings.colorMode === 'bw';
    const background = settings.background;
    const refinement = EDGE_REFINEMENT[settings.edgeRefinement] ?? EDGE_REFINEMENT[0];
    // Refinement radii are in original-image pixels; never go below one traced pixel.
    const pixelScale = Math.max(1, scale);

    if (background === 'remove' && !removeBackground(image)) {
        warnings.push('No uniform background colour was found along the image edges, so the background was kept.');
    }

    if (isBinary) {
        // The binary engine thresholds on RGB only, so transparent areas must read as light, not black.
        // A white or custom background is added afterwards as a vector rectangle behind the traced shapes.
        flattenOnto(image.data, { r: 255, g: 255, b: 255 });
        if (refinement.blur) gaussianBlur(image, refinement.blur * pixelScale);
        return { image, offsetY: 0, warnings, palette: null };
    }

    if (background === 'white' || background === 'custom') {
        flattenOnto(image.data, background === 'white' ? { r: 255, g: 255, b: 255 } : parseHexColor(settings.backgroundColor));
    } else {
        binarizeAlpha(image.data);
    }

    if (settings.colorMode === 'grayscale') toGrayscale(image.data);

    let palette = null;
    if (settings.colorCount > 0) {
        const limit = settings.colorCount === COLOR_COUNT_AUTO ? AUTO_PALETTE_LIMIT : settings.colorCount;
        // Detect on the sharp pixels: smoothing first would widen blends into extra colours.
        palette = detectPalette(image.data, limit);
        if (refinement.blur) gaussianBlur(image, refinement.blur * pixelScale);
        snapToPalette(image.data, palette);
        const radius = Math.round(refinement.majority * pixelScale);
        if (radius) refineEdges(image.data, image.width, image.height, palette, radius);
        const speck = settings.filterSpeckle * pixelScale;
        removeIslands(image.data, image.width, image.height, palette, Math.round(speck * speck));
    } else if (settings.gradientBands > 0) {
        posterize(image.data, settings.gradientBands);
    }

    const keyed = padForKeying(image);
    return { image: keyed.image, offsetY: keyed.offsetY, warnings, palette };
}
