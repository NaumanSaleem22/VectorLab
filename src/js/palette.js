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
/** Colours closer than this perceptual difference (CIELAB ΔE) are treated as the same colour. */
const MERGE_DELTA_E = 12;
/** A candidate this close to the line between two accepted colours is an anti-aliasing blend. */
const BLEND_DISTANCE = 16;
/** Pixels within this distance of a palette colour define its exact value. */
const CORE_DISTANCE = 24;
/** Ignore colours covering less than this share of the sampled pixels. */
const MIN_SHARE = 0.0004;
/** A colour owning less than this share and within HALO_DELTA_E of another is a halo. */
const HALO_SHARE = 0.01;
const HALO_DELTA_E = 25;
export const AUTO_PALETTE_LIMIT = 16;

const distSq = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** sRGB → CIELAB (D65). Lab distances match perceived difference far better than RGB. */
function toLab([r, g, b]) {
    const lin = (v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const [R, G, B] = [lin(r), lin(g), lin(b)];
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
    const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
    const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

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
            if (t > 0.02 && t < 0.98 && distance < BLEND_DISTANCE) return true;
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
    const mergeSq = MERGE_DELTA_E * MERGE_DELTA_E;
    const accepted = [];
    const acceptedLab = [];
    for (const { colour, count } of sorted) {
        if (accepted.length >= limit) break;
        if (count < minCount && accepted.length >= 2) break;
        const lab = toLab(colour);
        if (acceptedLab.some((c) => distSq(c, lab) < mergeSq)) continue;
        if (isBlend(colour, accepted)) continue;
        accepted.push(colour);
        acceptedLab.push(lab);
    }
    const refined = refine(data, accepted, step);
    return prune(data, refined, step).map((c) => c.map(Math.round));
}

/**
 * Drops colours that end up owning only a sliver of the image while looking close
 * to a bigger colour: compression halos (e.g. a pale pink rim where red meets
 * white in a JPEG) rather than real colours of the artwork.
 */
function prune(data, palette, step) {
    let current = palette;
    for (;;) {
        if (current.length <= 2) return current;
        const counts = new Array(current.length).fill(0);
        let total = 0;
        for (let i = 0; i < data.length; i += 4 * step) {
            if (data[i + 3] < 128) continue;
            counts[paletteIndexFor([data[i], data[i + 1], data[i + 2]], current)] += 1;
            total += 1;
        }
        const labs = current.map(toLab);
        let weakest = -1;
        for (let j = 0; j < current.length; j += 1) {
            const share = counts[j] / total;
            const nearest = Math.min(...labs.map((lab, o) => (o === j ? Infinity : Math.sqrt(distSq(lab, labs[j])))));
            const halo = share < HALO_SHARE && nearest < HALO_DELTA_E;
            const blend = isBlend(current[j], current.filter((_, o) => o !== j));
            if ((halo || blend || share < MIN_SHARE) && (weakest < 0 || counts[j] < counts[weakest])) weakest = j;
        }
        if (weakest < 0) return current;
        current = current.filter((_, j) => j !== weakest);
    }
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

/** Palette index per pixel of snapped data; transparent pixels get index `palette.length`. */
function toLabels(data, palette) {
    const transparent = palette.length;
    const keys = new Map(palette.map((c, i) => [(c[0] << 16) | (c[1] << 8) | c[2], i]));
    const labels = new Uint8Array(data.length / 4);
    for (let p = 0, i = 0; p < labels.length; p += 1, i += 4) {
        labels[p] = data[i + 3] < 128 ? transparent : keys.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]) ?? transparent;
    }
    return labels;
}

function writeLabels(data, labels, palette) {
    for (let p = 0, i = 0; p < labels.length; p += 1, i += 4) {
        const label = labels[p];
        if (label === palette.length) {
            data[i + 3] = 0;
            continue;
        }
        const c = palette[label];
        data[i] = c[0];
        data[i + 1] = c[1];
        data[i + 2] = c[2];
        data[i + 3] = 255;
    }
}

/**
 * Reassigns every connected patch smaller than `minArea` pixels to the colour it
 * borders most. Done here rather than by VTracer's speckle filter, whose merging
 * bends shared boundaries and leaves kinks and spurs where patches used to be.
 */
export function removeIslands(data, width, height, palette, minArea) {
    if (minArea < 2 || palette.length < 2) return;
    const labels = toLabels(data, palette);
    const seen = new Uint8Array(labels.length);
    const stack = new Int32Array(labels.length);
    const neighbours = new Int32Array(palette.length + 1);
    for (let start = 0; start < labels.length; start += 1) {
        if (seen[start]) continue;
        const own = labels[start];
        let top = 0;
        let size = 0;
        stack[top++] = start;
        seen[start] = 1;
        neighbours.fill(0);
        const members = [];
        while (top > 0) {
            const p = stack[--top];
            size += 1;
            if (size < minArea) members.push(p);
            const x = p % width;
            const around = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p >= width ? p - width : -1, p < labels.length - width ? p + width : -1];
            for (const q of around) {
                if (q < 0) continue;
                if (labels[q] !== own) neighbours[labels[q]] += 1;
                else if (!seen[q]) {
                    seen[q] = 1;
                    stack[top++] = q;
                }
            }
        }
        if (size >= minArea) continue;
        let best = -1;
        for (let c = 0; c < neighbours.length; c += 1) if (neighbours[c] > 0 && (best < 0 || neighbours[c] > neighbours[best])) best = c;
        if (best >= 0) for (const p of members) labels[p] = best;
    }
    writeLabels(data, labels, palette);
}

/**
 * Majority filter over the snapped colours: each pixel takes the colour that most
 * of its (2r+1)² neighbourhood has, when that clearly outnumbers its own. This
 * removes the notches, bumps and stray pixels that compression noise leaves on
 * edges, so the tracer fits clean outlines. Transparent pixels count as their own
 * colour, so transparent edges are refined too.
 */
export function refineEdges(data, width, height, palette, radius, passes = 1) {
    if (radius < 1 || palette.length < 2) return;
    const k = palette.length + 1;
    let labels = toLabels(data, palette);

    const colHist = new Int32Array(width * k);
    const rowHist = new Int32Array(k);
    for (let pass = 0; pass < passes; pass += 1) {
        const next = new Uint8Array(labels);
        colHist.fill(0);
        for (let y = 0; y <= Math.min(radius, height - 1); y += 1) {
            for (let x = 0; x < width; x += 1) colHist[x * k + labels[y * width + x]] += 1;
        }
        for (let y = 0; y < height; y += 1) {
            rowHist.fill(0);
            for (let x = 0; x <= Math.min(radius, width - 1); x += 1) {
                for (let c = 0; c < k; c += 1) rowHist[c] += colHist[x * k + c];
            }
            for (let x = 0; x < width; x += 1) {
                const p = y * width + x;
                const own = labels[p];
                let best = own;
                let bestCount = rowHist[own];
                for (let c = 0; c < k; c += 1) {
                    if (rowHist[c] > bestCount) {
                        bestCount = rowHist[c];
                        best = c;
                    }
                }
                next[p] = best;
                const add = x + radius + 1;
                const drop = x - radius;
                if (add < width) for (let c = 0; c < k; c += 1) rowHist[c] += colHist[add * k + c];
                if (drop >= 0) for (let c = 0; c < k; c += 1) rowHist[c] -= colHist[drop * k + c];
            }
            const addRow = y + radius + 1;
            const dropRow = y - radius;
            if (addRow < height) for (let x = 0; x < width; x += 1) colHist[x * k + labels[addRow * width + x]] += 1;
            if (dropRow >= 0) for (let x = 0; x < width; x += 1) colHist[x * k + labels[dropRow * width + x]] -= 1;
        }
        labels = next;
    }

    writeLabels(data, labels, palette);
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

const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * Rewrites every `fill="#rrggbb"` in the traced SVG to its nearest palette colour.
 * VTracer averages colours when it merges small specks into neighbours, which
 * leaves near-duplicate shades; snapping keeps the exact brand colours.
 */
export function snapSvgFills(svg, palette) {
    if (!palette?.length) return svg;
    const labs = palette.map(toLab);
    return svg.replace(/fill="#([0-9a-f]{6})"/gi, (match, value) => {
        const n = parseInt(value, 16);
        const lab = toLab([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
        let best = 0;
        for (let j = 1; j < labs.length; j += 1) if (distSq(lab, labs[j]) < distSq(lab, labs[best])) best = j;
        return `fill="${hex(palette[best])}"`;
    });
}
