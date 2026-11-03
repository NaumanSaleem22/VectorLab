import { UserFacingError, formatBytes } from './utils.js';

export const SUPPORTED_TYPES = {
    'image/png': 'PNG',
    'image/jpeg': 'JPEG',
    'image/webp': 'WebP',
};

const EXTENSION_TYPES = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
};

export const LIMITS = {
    maxFileBytes: 30 * 1024 * 1024,
    maxPixels: 50_000_000,
    maxSide: 12_000,
    minSide: 8,
};

/** Reads the first bytes of the file so the format is checked by content, not just by name. */
async function sniffType(file) {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
    if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
    return null;
}

function extensionType(name) {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    return EXTENSION_TYPES[ext] ?? null;
}

async function decode(file) {
    try {
        return await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
    } catch (error) {
        throw new UserFacingError('This image could not be decoded. The file may be corrupted or incomplete.', error);
    }
}

/**
 * Validates and decodes an uploaded file.
 * Resolves to the decoded bitmap plus display metadata; the caller owns the bitmap and must close it.
 */
export async function loadImage(file) {
    if (!file) throw new UserFacingError('No file was selected.');

    const declared = SUPPORTED_TYPES[file.type] ? file.type : extensionType(file.name);
    if (!declared) {
        throw new UserFacingError('Unsupported file type. Please choose a PNG, JPG, JPEG or WebP image.');
    }
    if (file.size === 0) throw new UserFacingError('This file is empty.');
    if (file.size > LIMITS.maxFileBytes) {
        throw new UserFacingError(
            `This file is ${formatBytes(file.size)}. The maximum supported size is ${formatBytes(LIMITS.maxFileBytes)}.`,
        );
    }

    const actual = await sniffType(file);
    if (!actual) {
        throw new UserFacingError('This file does not contain valid PNG, JPEG or WebP data.');
    }

    const bitmap = await decode(file);
    const { width, height } = bitmap;

    const fail = (message) => {
        bitmap.close();
        throw new UserFacingError(message);
    };
    if (width < LIMITS.minSide || height < LIMITS.minSide) {
        fail(`This image is only ${width}×${height}px. Images must be at least ${LIMITS.minSide}px on each side.`);
    }
    if (width > LIMITS.maxSide || height > LIMITS.maxSide || width * height > LIMITS.maxPixels) {
        fail(
            `This image is ${width}×${height}px, which is too large to process safely in the browser. ` +
                `Please use an image under ${LIMITS.maxSide.toLocaleString()}px per side and ${LIMITS.maxPixels / 1e6} megapixels.`,
        );
    }

    return {
        bitmap,
        meta: {
            name: file.name,
            size: file.size,
            type: actual,
            format: SUPPORTED_TYPES[actual],
            width,
            height,
        },
    };
}
