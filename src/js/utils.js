export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(ms) {
    if (!Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

export function formatNumber(value) {
    return Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
}

export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

export function byteLength(text) {
    return new Blob([text]).size;
}

/** An error whose message is safe to show to users; `cause` keeps the technical detail. */
export class UserFacingError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'UserFacingError';
        this.cause = cause;
    }
}

export function toUserMessage(error, fallback) {
    return error instanceof UserFacingError ? error.message : fallback;
}
