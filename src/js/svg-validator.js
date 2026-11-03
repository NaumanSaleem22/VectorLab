const SVG_NS = 'http://www.w3.org/2000/svg';
const GEOMETRY = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line']);
const FORBIDDEN = new Set(['script', 'foreignObject', 'iframe', 'object', 'embed', 'audio', 'video', 'canvas']);
const RASTER_DATA = /data:image\/(png|jpe?g|webp|gif|bmp|avif)/i;
const EXTERNAL_URL = /url\(\s*['"]?(?!#)[^)]+\)/i;

function parseViewBox(value) {
    if (!value) return null;
    const parts = value.trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || parts[2] <= 0 || parts[3] <= 0) return null;
    return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

/**
 * Removes anything that could execute code or load external resources:
 * scripts, embedded documents, event handlers and non-fragment references.
 * VTracer never emits these, so for engine output this is a safety net and
 * `removed` is expected to stay 0.
 */
function sanitize(doc) {
    let removed = 0;
    for (const el of [...doc.getElementsByTagName('*')]) {
        if (FORBIDDEN.has(el.localName) || el.localName === 'image') {
            el.remove();
            removed += 1;
            continue;
        }
        for (const attr of [...el.attributes]) {
            const name = attr.name.toLowerCase();
            const value = attr.value;
            const unsafe =
                name.startsWith('on') ||
                ((name === 'href' || name === 'xlink:href') && !value.startsWith('#')) ||
                EXTERNAL_URL.test(value) ||
                /javascript:/i.test(value);
            if (unsafe) {
                el.removeAttribute(attr.name);
                removed += 1;
            }
        }
    }
    return removed;
}

/**
 * Parses and inspects an SVG string. Returns validation checks, measured
 * statistics and a sanitized serialization safe to render.
 */
export function validateSvg(text) {
    const checks = [];
    const add = (id, label, ok, detail = '') => checks.push({ id, label, ok, detail });

    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const parserError = doc.getElementsByTagName('parsererror')[0];
    const root = doc.documentElement;
    const wellFormed = !parserError && root?.localName === 'svg' && root.namespaceURI === SVG_NS;
    add('xml', 'Well-formed SVG XML', wellFormed, parserError ? parserError.textContent.split('\n')[0] : '');
    if (!wellFormed) {
        return { valid: false, checks, stats: null, sanitized: null };
    }

    const viewBox = parseViewBox(root.getAttribute('viewBox'));
    add('viewbox', 'Valid viewBox', Boolean(viewBox), viewBox ? `${viewBox.width} × ${viewBox.height}` : 'missing or invalid');

    const rasterEls = doc.getElementsByTagName('image').length;
    const rasterData = RASTER_DATA.test(text);
    add('raster', 'No embedded raster images', rasterEls === 0 && !rasterData, rasterEls ? `${rasterEls} <image> element(s)` : '');

    let pathCount = 0;
    let shapeCount = 0;
    let emptyPaths = 0;
    const colors = new Set();
    for (const el of doc.getElementsByTagName('*')) {
        if (!GEOMETRY.has(el.localName)) continue;
        shapeCount += 1;
        if (el.localName === 'path') {
            pathCount += 1;
            if (!el.getAttribute('d')?.trim()) emptyPaths += 1;
        }
        const fill = el.getAttribute('fill') ?? el.closest('[fill]')?.getAttribute('fill');
        if (fill && fill !== 'none') colors.add(fill.toLowerCase());
    }
    add('geometry', 'Contains vector geometry', shapeCount - emptyPaths > 0, `${shapeCount.toLocaleString()} shapes`);

    const unsafeCount = sanitize(doc);
    add('safe', 'No scripts or external references', unsafeCount === 0, unsafeCount ? `${unsafeCount} item(s) removed` : '');

    const sanitized = unsafeCount === 0 ? text : new XMLSerializer().serializeToString(doc);
    return {
        valid: checks.every((c) => c.ok),
        checks,
        sanitized,
        stats: {
            width: Number.parseFloat(root.getAttribute('width')) || viewBox?.width || 0,
            height: Number.parseFloat(root.getAttribute('height')) || viewBox?.height || 0,
            viewBox,
            pathCount,
            shapeCount,
            colorCount: colors.size,
        },
    };
}

/** Confirms the browser can reopen and render the exact bytes a download would contain. */
export async function verifyReopen(blob) {
    const text = await blob.text();
    const reparsed = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (reparsed.getElementsByTagName('parsererror').length) return false;
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img.naturalWidth > 0;
    } catch {
        return false;
    } finally {
        URL.revokeObjectURL(url);
    }
}
