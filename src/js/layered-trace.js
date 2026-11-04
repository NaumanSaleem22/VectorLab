/**
 * Seamless layered tracing for palette-snapped artwork.
 *
 * VTracer's own modes each leave artefacts on flat logos: "stacked" layers only
 * extend under shapes they fully enclose, so where two shapes meet over a third
 * a hairline of the lower colour shows through; "cutout" fits shared boundaries
 * as loops with arbitrary start points, leaving small kinks.
 *
 * Here every palette colour becomes one layer, painted from most to least common.
 * Each layer is traced (with VTracer's binary mode) from its own pixels plus a
 * narrow band reaching under the neighbouring layers painted above it, so seams
 * between neighbours are always backed by colour. The band stays narrow so that
 * a hidden layer never shares a visible edge with the shape covering it, which
 * would blend the hidden colour into the anti-aliasing as a fringe.
 */

const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** Palette index per pixel; -1 for transparent. */
function labelsOf(data, palette) {
    const keys = new Map(palette.map((c, i) => [(c[0] << 16) | (c[1] << 8) | c[2], i]));
    const labels = new Int8Array(data.length / 4);
    for (let p = 0, i = 0; p < labels.length; p += 1, i += 4) {
        labels[p] = data[i + 3] < 128 ? -1 : keys.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]) ?? -1;
    }
    return labels;
}

/**
 * The layer's own pixels, grown by `overlap` steps into pixels of layers painted
 * above it (never into lower layers or transparency).
 */
function underlap(labels, rank, index, position, width, overlap) {
    const inLayer = new Uint8Array(labels.length);
    let frontier = [];
    for (let p = 0; p < labels.length; p += 1) {
        if (labels[p] === index) {
            inLayer[p] = 1;
            frontier.push(p);
        }
    }
    for (let step = 0; step < overlap && frontier.length; step += 1) {
        const next = [];
        for (const p of frontier) {
            const x = p % width;
            for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
                if (q < 0 || q >= labels.length || inLayer[q]) continue;
                const label = labels[q];
                if (label >= 0 && rank[label] > position) {
                    inLayer[q] = 1;
                    next.push(q);
                }
            }
        }
        frontier = next;
    }
    return inLayer;
}

function pathsOf(svg, colour) {
    const fill = `fill="${hex(colour)}"`;
    return (svg.match(/<path\b[^>]*\/>/g) ?? []).map((path) =>
        /\bfill="[^"]*"/.test(path) ? path.replace(/\bfill="[^"]*"/, fill) : path.replace('<path', `<path ${fill}`),
    );
}

/**
 * @param {{ data: Uint8ClampedArray, width: number, height: number }} image palette-snapped pixels
 * @param {number[][]} palette
 * @param {(rgba: Uint8Array, width: number, height: number, options: object) => string} vectorize VTracer entry point
 * @param {object} engineOptions curve-fitting options shared by every layer
 * @param {number} overlap how far (traced px) a layer reaches under the layers above it
 * @returns {string} an SVG document
 */
export function traceLayers({ data, width, height }, palette, vectorize, engineOptions, overlap = 2) {
    const labels = labelsOf(data, palette);
    const counts = new Array(palette.length).fill(0);
    let opaque = 0;
    for (const label of labels) {
        if (label >= 0) {
            counts[label] += 1;
            opaque += 1;
        }
    }
    const order = palette.map((_, i) => i).filter((i) => counts[i] > 0).sort((a, b) => counts[b] - counts[a]);
    const rank = new Int8Array(palette.length).fill(-1);
    order.forEach((index, position) => (rank[index] = position));

    const options = {
        ...engineOptions,
        clustering: 'bw',
        binaryThreshold: 128,
        adaptive: false,
    };
    delete options.hierarchical;
    delete options.colorPrecision;
    delete options.layerDifference;

    const mask = new Uint8Array(width * height * 4).fill(255);
    const body = [];
    order.forEach((index, position) => {
        if (position === 0 && opaque === labels.length) {
            // The bottom layer of an opaque image covers everything beneath the others.
            body.push(`<path fill="${hex(palette[index])}" d="M0 0H${width}V${height}H0Z"/>`);
            return;
        }
        const inLayer = underlap(labels, rank, index, position, width, overlap);
        for (let p = 0; p < labels.length; p += 1) {
            const v = inLayer[p] ? 0 : 255;
            const i = p * 4;
            mask[i] = v;
            mask[i + 1] = v;
            mask[i + 2] = v;
        }
        body.push(...pathsOf(vectorize(mask, width, height, options), palette[index]));
    });

    return `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">\n${body.join('\n')}\n</svg>\n`;
}
