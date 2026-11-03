import { optimize } from 'svgo/browser';

/** Above this size multipass optimization costs far more time than it saves bytes. */
const MULTIPASS_LIMIT = 2 * 1024 * 1024;

/**
 * Rewrites VTracer's root element so the document scales cleanly:
 * a viewBox in traced-pixel space, width/height at the original image size,
 * and an optional vector background rectangle.
 */
export function finalizeSvg(svg, { traceWidth, traceHeight, offsetY, outputWidth, outputHeight, backgroundColor }) {
    const viewHeight = traceHeight - offsetY * 2;
    const root =
        `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" ` +
        `width="${outputWidth}" height="${outputHeight}" viewBox="0 ${offsetY} ${traceWidth} ${viewHeight}">`;
    const background = backgroundColor
        ? `\n<rect x="0" y="${offsetY}" width="${traceWidth}" height="${viewHeight}" fill="${backgroundColor}"/>`
        : '';
    let replaced = false;
    const result = svg.replace(/<svg\b[^>]*>/, () => {
        replaced = true;
        return root + background;
    });
    if (!replaced) throw new Error('Engine output has no <svg> root element.');
    return result;
}

/**
 * SVGO with settings that keep the artwork intact: the viewBox and dimensions
 * are preserved, and numeric rounding never goes below the precision VTracer
 * already wrote, so geometry is not visibly altered.
 */
export function optimizeSvg(svg, { pathPrecision }) {
    const floatPrecision = Math.max(2, pathPrecision);
    const result = optimize(svg, {
        multipass: svg.length < MULTIPASS_LIMIT,
        floatPrecision,
        plugins: [
            {
                name: 'preset-default',
                params: {
                    overrides: {
                        convertPathData: { floatPrecision, transformPrecision: floatPrecision + 2 },
                        cleanupNumericValues: { floatPrecision },
                        convertShapeToPath: false,
                    },
                },
            },
            'removeXlink',
            'removeScripts',
        ],
    });
    return result.data;
}
