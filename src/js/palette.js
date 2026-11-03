/**
 * Palette detection and snapping for flat-colour artwork.
 *
 * Anti-aliased edges contain blended in-between colours. VTracer traces those
 * blends as thin extra shapes (halos along every edge) and they can steal
 * colour slots from real colours. Snapping every pixel to the artwork's true
 * palette before tracing removes the blends, so each region is one clean shape
 * and boundaries fall exactly halfway across the original anti-aliasing.
 */

const SAMPLE_TARGET = 120_000;
/** Colours closer than this (RGB distance) are treated as the same colour. */
const MERGE_DISTANCE = 30;
/** A candidate this close to the line between two accepted colours is an anti-aliasing blend. */
const BLEND_DISTANCE = 16;
/** Pixels within this distance of a palette colour define its exact value. */
const CORE_DISTANCE = 24;
/** Ignore colours covering less than this share of the sampled pixels. */
const MIN_SHARE = 0.0004;
export const AUTO_PALETTE_LIMIT = 16;

const distSq = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

function distanceToSegment(p, a, b) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const lenSq = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    if (!lenSq) return { distance: Math.sqrt(distSq(p, a)), t: 0 };
    const t = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / lenSq;
    const clamped = Math.min(1, Math.max(0, t));
    const q = [a[0] + ab[0] * clamped, a[1] + ab[1] * clamped, a[2] + ab[2] * clamped];
    return { distance: Math.sqrt(distSq(p, q)), t };
}

function isBlend(colour, accepted) {
    for (let i = 0; i < accepted.length; i += 1) {
        for (let j = i + 1; j < accepted.length; j += 1) {
            const { distance, t } = distanceToSegment(colour, accepted[i], accepted[j]);
            if (t > 0.08 && t < 0.92 && distance < BLEND_DISTANCE) return true;
        }
    }
    return false;
}

/** Histogram of opaque pixels on a 5-bit-per-channel grid, most frequent bins first. */
function histogram(data) {
    const pixels = data.length / 4;
    const step = Math.max(1, Math.floor(pixels / SAMPLE_TARGET));
    const bins = new Map();
    let samples = 0;
    for (let p = 0; p < pixels; p += step) {
        const i = p * 4;
        if (data[i + 3] < 128) continue;
        samples += 1;
        const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
        let bin = bins.get(key);
        if (!bin) {
            bin = [0, 0, 0, 0];
            bins.set(key, bin);
        }
        bin[0] += data[i];
        bin[1] += data[i + 1];
        bin[2] += data[i + 2];
        bin[3] += 1;
    }
    const sorted = [...bins.values()]
        .map(([r, g, b, count]) => ({ colour: [r / count, g / count, b / count], count }))
        .sort((a, b) => b.count - a.count);
    return { sorted, samples, step };
}

/** Recomputes each palette colour as the mean of the pixels that clearly belong to it. */
function refine(data, palette, step) {
    const sums = palette.map(() => [0, 0, 0, 0]);
    const coreSq = CORE_DISTANCE * CORE_DISTANCE;
    for (let i = 0; i < data.length; i += 4 * step) {
        if (data[i + 3] < 128) continue;
        const p = [data[i], data[i + 1], data[i + 2]];
        for (let j = 0; j < palette.length; j += 1) {
            if (distSq(p, palette[j]) <= coreSq) {
                const s = sums[j];
                s[0] += p[0];
                s[1] += p[1];
                s[2] += p[2];
                s[3] += 1;
                break;
            }
        }
    }
    return palette.map((c, j) => (sums[j][3] ? sums[j].slice(0, 3).map((v) => v / sums[j][3]) : c));
}

/**
 * Finds the dominant colours of flat artwork, skipping anti-aliasing blends.
 * @param {number} limit maximum number of colours to return
 */
export function detectPalette(data, limit) {
    const { sorted, samples, step } = histogram(data);
    const minCount = Math.max(3, samples * MIN_SHARE);
    const mergeSq = MERGE_DISTANCE * MERGE_DISTANCE;
    const accepted = [];
    for (const { colour, count } of sorted) {
        if (accepted.length >= limit) break;
        if (count < minCount && accepted.length >= 2) break;
        if (accepted.some((c) => distSq(c, colour) < mergeSq)) continue;
        if (isBlend(colour, accepted)) continue;
        accepted.push(colour);
    }
    return refine(data, accepted, step).map((c) => c.map(Math.round));
}

/**
 * Picks the palette entry for one colour. An edge pixel blended from two palette
 * colours goes to the nearer of those two, so a yellow-on-green edge never turns
 * into a rim of some third colour (such as orange) that happens to sit closer.
 */
function paletteIndexFor(p, palette) {
    let nearest = 0;
    let nearestDist = Infinity;
    for (let j = 0; j < palette.length; j += 1) {
        const d = distSq(p, palette[j]);
        if (d < nearestDist) {
            nearestDist = d;
            nearest = j;
        }
    }
    if (nearestDist <= CORE_DISTANCE * CORE_DISTANCE) return nearest;

    let blend = null;
    for (let a = 0; a < palette.length; a += 1) {
        for (let b = a + 1; b < palette.length; b += 1) {
            const { distance, t } = distanceToSegment(p, palette[a], palette[b]);
            if (t > 0 && t < 1 && distance < BLEND_DISTANCE * 1.5 && (!blend || distance < blend.distance)) {
                blend = { distance, index: t < 0.5 ? a : b };
            }
        }
    }
    return blend ? blend.index : nearest;
}

/** Replaces every opaque pixel with its palette colour, in place. */
export function snapToPalette(data, palette) {
    if (palette.length < 2) return;
    const cache = new Map();
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        let best = cache.get(key);
        if (best === undefined) {
            best = paletteIndexFor([data[i], data[i + 1], data[i + 2]], palette);
            cache.set(key, best);
        }
        const c = palette[best];
        data[i] = c[0];
        data[i + 1] = c[1];
        data[i + 2] = c[2];
    }
}
