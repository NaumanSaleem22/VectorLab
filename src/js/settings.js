/**
 * Vectorization settings: defaults, presets, and the mapping from UI settings
 * to VTracer engine options. Settings that VTracer does not expose directly
 * (grayscale, colour count, gradient bands, background handling, processing
 * size and upscaling) are applied as pixel preprocessing instead; see
 * image-preprocessor.js and palette.js.
 *
 * `colorCount`: 0 = unlimited, 1 = auto-detected palette, 2+ = that many colours.
 * `edgeRefinement`: 0 = off, 1–3 = low/medium/high edge clean-up (see image-preprocessor.js).
 */

/** Detail level 1–10 → VTracer `layerDifference` (colour gap between gradient layers). */
const DETAIL_TO_LAYER_DIFFERENCE = [128, 96, 64, 48, 32, 24, 16, 12, 8, 4];

export const DEFAULT_SETTINGS = {
    preset: 'illustration',
    colorMode: 'color',
    colorCount: 0,
    detail: 7,
    colorPrecision: 7,
    gradientBands: 0,
    filterSpeckle: 4,
    mode: 'spline',
    cornerThreshold: 60,
    simplify: 0,
    pathPrecision: 2,
    hierarchical: 'stacked',
    threshold: 128,
    adaptive: false,
    background: 'preserve',
    backgroundColor: '#ffffff',
    maxSize: 2048,
    upscale: false,
    edgeRefinement: 0,
};

export const PRESETS = {
    logo: {
        label: 'Logo',
        description: 'Flat colours, crisp edges and an auto-detected palette.',
        settings: {
            colorMode: 'color',
            colorCount: 1,
            detail: 8,
            colorPrecision: 8,
            gradientBands: 0,
            filterSpeckle: 4,
            mode: 'spline',
            cornerThreshold: 60,
            simplify: 2,
            pathPrecision: 2,
            hierarchical: 'cutout',
            maxSize: 2048,
            upscale: true,
            edgeRefinement: 1,
        },
    },
    illustration: {
        label: 'Illustration',
        description: 'Detailed artwork with many colours and smooth curves.',
        settings: {
            colorMode: 'color',
            colorCount: 0,
            detail: 7,
            colorPrecision: 7,
            gradientBands: 16,
            filterSpeckle: 4,
            mode: 'spline',
            cornerThreshold: 60,
            simplify: 0,
            pathPrecision: 2,
            hierarchical: 'stacked',
            maxSize: 2048,
            upscale: false,
            edgeRefinement: 0,
        },
    },
    photo: {
        label: 'Photograph',
        description: 'Coarser colour layers and heavier speckle filtering (VTracer photo preset).',
        settings: {
            colorMode: 'color',
            colorCount: 0,
            detail: 4,
            colorPrecision: 8,
            gradientBands: 0,
            filterSpeckle: 10,
            mode: 'spline',
            cornerThreshold: 180,
            simplify: 0,
            pathPrecision: 1,
            hierarchical: 'stacked',
            maxSize: 1024,
            upscale: false,
            edgeRefinement: 0,
        },
    },
    bw: {
        label: 'Black & White',
        description: 'Binary tracing for line art, text and stamps.',
        settings: {
            colorMode: 'bw',
            threshold: 128,
            adaptive: false,
            filterSpeckle: 4,
            mode: 'spline',
            cornerThreshold: 60,
            simplify: 1,
            pathPrecision: 2,
            maxSize: 2048,
            upscale: true,
            edgeRefinement: 1,
        },
    },
};

export function applyPreset(settings, presetId) {
    const preset = PRESETS[presetId];
    if (!preset) return settings;
    return { ...settings, ...preset.settings, preset: presetId };
}

export function layerDifferenceFor(detail) {
    const index = Math.min(10, Math.max(1, Math.round(detail))) - 1;
    return DETAIL_TO_LAYER_DIFFERENCE[index];
}

/**
 * Builds the options object passed to VTracer's `vectorize_rgba`.
 * @param {number} scale trace size ÷ original size; when an image was upscaled,
 *   the speckle filter is scaled with it so it still means original-image pixels.
 */
export function toEngineOptions(settings, scale = 1) {
    const options = {
        mode: settings.mode,
        filterSpeckle: Math.round(settings.filterSpeckle * Math.max(1, scale)),
        pathPrecision: settings.pathPrecision,
        optimize: 1,
    };

    if (settings.mode === 'spline') {
        options.cornerThreshold = settings.cornerThreshold;
        if (settings.simplify > 0) options.simplify = settings.simplify;
    }

    if (settings.colorMode === 'bw') {
        options.clustering = 'bw';
        if (settings.adaptive) options.adaptive = true;
        else options.binaryThreshold = settings.threshold;
        return options;
    }

    options.clustering = 'color-cluster';
    options.hierarchical = settings.hierarchical;
    options.colorPrecision = settings.colorPrecision;
    options.layerDifference = layerDifferenceFor(settings.detail);
    return options;
}
