export const SVG_MIME = 'image/svg+xml;charset=utf-8';

/** my-logo.png → my-logo.svg; strips characters that are invalid in file names. */
export function svgFileName(originalName, suffix = '') {
    const base = (originalName || 'vector')
        .replace(/\.[^./\\]+$/, '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
        .trim()
        .slice(0, 120) || 'vector';
    return `${base}${suffix}.svg`;
}

export function svgBlob(text) {
    return new Blob([text], { type: SVG_MIME });
}

export function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return;
    } catch (error) {
        console.warn('[VectorLab] Clipboard API unavailable, using fallback', error);
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) throw new Error('Clipboard is unavailable');
}
