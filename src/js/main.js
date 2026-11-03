import '../scss/main.scss';
import { loadImage } from './image-loader.js';
import { processingSize, rasterize } from './image-preprocessor.js';
import { DEFAULT_SETTINGS, PRESETS, applyPreset } from './settings.js';
import { Vectorizer, CancelledError } from './vectorizer.js';
import { validateSvg, verifyReopen } from './svg-validator.js';
import { Viewer } from './preview.js';
import { Comparison } from './comparison.js';
import { copyText, downloadBlob, svgBlob, svgFileName } from './download.js';
import { $, $$, UserFacingError, byteLength, formatBytes, formatDuration, formatNumber, toUserMessage } from './utils.js';

const STAGES = {
    prepare: 'Preparing image…',
    init: 'Initializing vectorization engine…',
    preprocess: 'Preprocessing pixels…',
    trace: 'Tracing shapes…',
    generate: 'Generating SVG…',
    optimize: 'Optimizing SVG with SVGO…',
    validate: 'Validating SVG…',
};
const SOURCE_PREVIEW_LIMIT = 400 * 1024;

const plural = (count, noun) => `${formatNumber(count)} ${noun}${count === 1 ? '' : 's'}`;

const el = {
    dropzone: $('#dropzone'),
    dropLoading: $('#dropLoading'),
    fileInput: $('#fileInput'),
    browseButton: $('#browseButton'),
    heroCta: $('#heroCta'),
    workspace: $('#workspace'),
    errorBanner: $('#errorBanner'),
    errorText: $('#errorText'),
    fileThumb: $('#fileThumb'),
    fileName: $('#fileName'),
    fileMeta: $('#fileMeta'),
    viewer: $('#viewer'),
    compare: $('#compare'),
    originalImage: $('#originalImage'),
    vectorImage: $('#vectorImage'),
    modeToggle: $('#modeToggle'),
    bgToggle: $('#bgToggle'),
    zoomLevel: $('#zoomLevel'),
    progress: $('#progress'),
    progressStage: $('#progressStage'),
    progressHint: $('#progressHint'),
    results: $('#results'),
    resultsSubtitle: $('#resultsSubtitle'),
    variantToggle: $('#variantToggle'),
    staleNote: $('#staleNote'),
    stats: $('#stats'),
    checks: $('#checks'),
    warnings: $('#warnings'),
    form: $('#settingsForm'),
    presets: $('#presets'),
    convertButton: $('#convertButton'),
    settingsNote: $('#settingsNote'),
    backgroundColorRow: $('#backgroundColorRow'),
    backgroundColorValue: $('#backgroundColorValue'),
    backgroundHint: $('#backgroundHint'),
    sourceDialog: $('#sourceDialog'),
    sourceToggle: $('#sourceToggle'),
    sourceCode: $('#sourceCode'),
    sourceSize: $('#sourceSize'),
    sourceNote: $('#sourceNote'),
    toast: $('#toast'),
};

const state = {
    image: null,
    originalUrl: null,
    settings: { ...DEFAULT_SETTINGS },
    result: null,
    variant: 'optimized',
    sourceVariant: 'optimized',
    converting: false,
    lastCompareMode: 'split',
};

const vectorizer = new Vectorizer();
const viewer = new Viewer($$('[data-viewport]', el.compare), {
    onChange: (scale) => {
        el.zoomLevel.textContent = `${Math.round(scale * 100)}%`;
    },
});
const comparison = new Comparison(el.compare, { onModeChange: () => requestAnimationFrame(() => viewer.fit()) });

/* ---------- feedback ---------- */

let toastTimer;
function toast(message) {
    el.toast.textContent = message;
    el.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), 2600);
}

function showError(message) {
    el.errorText.textContent = message;
    el.errorBanner.hidden = false;
    el.errorBanner.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function clearError() {
    el.errorBanner.hidden = true;
}

/* ---------- radio groups built from buttons ---------- */

function setRadioGroup(group, attribute, value) {
    for (const button of $$('[role="radio"]', group)) {
        const checked = button.dataset[attribute] === value;
        button.setAttribute('aria-checked', String(checked));
        button.tabIndex = checked ? 0 : -1;
    }
}

function bindRadioGroup(group, attribute, onSelect) {
    group.addEventListener('click', (event) => {
        const button = event.target.closest('[role="radio"]');
        if (button && !button.disabled) onSelect(button.dataset[attribute]);
    });
    group.addEventListener('keydown', (event) => {
        const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
        if (!(event.key in keys)) return;
        event.preventDefault();
        const buttons = $$('[role="radio"]:not([disabled])', group);
        const index = buttons.indexOf(document.activeElement);
        const next = buttons[(index + keys[event.key] + buttons.length) % buttons.length];
        next.focus();
        onSelect(next.dataset[attribute]);
    });
}

/* ---------- image loading ---------- */

function releaseResult() {
    if (!state.result) return;
    for (const variant of [state.result.raw, state.result.optimized]) {
        if (variant?.url) URL.revokeObjectURL(variant.url);
    }
    state.result = null;
    el.vectorImage.removeAttribute('src');
}

function releaseImage() {
    vectorizer.cancel();
    releaseResult();
    state.image?.bitmap.close();
    state.image = null;
    if (state.originalUrl) URL.revokeObjectURL(state.originalUrl);
    state.originalUrl = null;
    el.originalImage.removeAttribute('src');
    el.fileThumb.removeAttribute('src');
}

async function handleFile(file) {
    if (!file || state.converting) return;
    clearError();
    el.dropLoading.hidden = false;
    el.dropzone.classList.add('is-loading');
    try {
        const loaded = await loadImage(file);
        releaseImage();
        state.image = loaded;
        state.originalUrl = URL.createObjectURL(file);
        showWorkspace();
    } catch (error) {
        // Validation rejections are expected; only log failures that carry technical detail.
        if (!(error instanceof UserFacingError) || error.cause) console.warn('[VectorLab] Could not load image', error.cause ?? error);
        showError(toUserMessage(error, 'This image could not be opened.'));
    } finally {
        el.dropLoading.hidden = true;
        el.dropzone.classList.remove('is-loading');
        el.fileInput.value = '';
    }
}

function showWorkspace() {
    const { meta } = state.image;
    el.originalImage.src = state.originalUrl;
    el.fileThumb.src = state.originalUrl;
    el.fileName.textContent = meta.name;
    el.fileName.title = meta.name;
    el.fileMeta.replaceChildren(
        ...[formatBytes(meta.size), `${meta.width} × ${meta.height} px`, meta.format].map((text) => {
            const item = document.createElement('li');
            item.textContent = text;
            return item;
        }),
    );
    el.vectorImage.width = meta.width;
    el.vectorImage.height = meta.height;
    el.originalImage.width = meta.width;
    el.originalImage.height = meta.height;

    el.dropzone.hidden = true;
    el.workspace.hidden = false;
    el.results.hidden = true;
    comparison.setMode('original');
    el.modeToggle.classList.add('is-disabled');
    $$('button', el.modeToggle).forEach((b) => (b.disabled = true));
    viewer.setContentSize(meta.width, meta.height);
    updateSettingsNote();
    $('#tool').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetToUpload() {
    releaseImage();
    el.workspace.hidden = true;
    el.dropzone.hidden = false;
    clearError();
    el.browseButton.focus();
}

/* ---------- settings ---------- */

function buildPresets() {
    el.presets.replaceChildren(
        ...Object.entries(PRESETS).map(([id, preset]) => {
            const label = document.createElement('label');
            label.className = 'preset';
            label.innerHTML = `<input type="radio" name="preset" value="${id}"><span class="preset__name"></span><span class="preset__desc"></span>`;
            label.querySelector('.preset__name').textContent = preset.label;
            label.querySelector('.preset__desc').textContent = preset.description;
            return label;
        }),
    );
}

function writeSettings(settings) {
    const form = el.form;
    for (const [name, value] of Object.entries(settings)) {
        const field = form.elements[name];
        if (!field) continue;
        if (field instanceof RadioNodeList) {
            for (const radio of field) radio.checked = radio.value === String(value);
        } else if (field.type === 'checkbox') {
            field.checked = Boolean(value);
        } else {
            field.value = String(value);
        }
    }
    if (!PRESETS[settings.preset]) {
        for (const radio of form.elements.preset) radio.checked = false;
    }
    refreshSettingsUi();
}

function readSettings() {
    const form = el.form;
    const num = (name) => Number(form.elements[name].value);
    return {
        preset: state.settings.preset,
        colorMode: form.elements.colorMode.value,
        maxColors: num('maxColors') === 1 ? 2 : num('maxColors'),
        detail: num('detail'),
        colorPrecision: num('colorPrecision'),
        gradientBands: num('gradientBands'),
        filterSpeckle: num('filterSpeckle'),
        mode: form.elements.mode.value,
        cornerThreshold: num('cornerThreshold'),
        simplify: num('simplify'),
        pathPrecision: num('pathPrecision'),
        hierarchical: form.elements.hierarchical.value,
        threshold: num('threshold'),
        adaptive: form.elements.adaptive.checked,
        background: form.elements.background.value,
        backgroundColor: form.elements.backgroundColor.value,
        maxSize: num('maxSize'),
    };
}

const OUTPUT_FORMAT = {
    maxColors: (v) => (v === 0 ? 'Unlimited' : `${Math.max(2, v)}`),
    detail: (v) => `${v} / 10`,
    threshold: (v) => `${v}`,
    filterSpeckle: (v) => (v === 0 ? 'Off' : `${v} px`),
    simplify: (v) => (v === 0 ? 'Off' : `${v} px`),
    cornerThreshold: (v) => `${v}°`,
    pathPrecision: (v) => `${v} dp`,
    colorPrecision: (v) => `${v} bit`,
    gradientBands: (v) => (v === 0 ? 'Off' : `${v} levels`),
};

const BACKGROUND_HINTS = {
    preserve: 'Transparent areas stay transparent; opaque backgrounds are traced as shapes.',
    remove: 'Removes a solid background colour connected to the image edges.',
    white: 'Fills transparent areas with white before tracing.',
    custom: 'Fills transparent areas with your colour before tracing.',
};

function refreshSettingsUi() {
    const settings = readSettings();
    const form = el.form;
    for (const output of $$('[data-output]', form)) {
        const name = output.dataset.output;
        output.textContent = OUTPUT_FORMAT[name](Number(form.elements[name].value));
    }
    for (const range of $$('input[type="range"]', form)) {
        const percent = ((range.value - range.min) / (range.max - range.min)) * 100;
        range.style.setProperty('--p', `${percent}%`);
    }
    for (const field of $$('[data-show-for]', form)) {
        field.hidden = !field.dataset.showFor.split(' ').includes(settings.colorMode);
    }
    for (const input of $$('[data-spline-only]', form)) {
        input.disabled = settings.mode !== 'spline';
        input.closest('.field').classList.toggle('is-disabled', input.disabled);
    }
    form.elements.threshold.disabled = settings.adaptive;
    el.backgroundColorRow.hidden = settings.background !== 'custom';
    el.backgroundColorValue.textContent = settings.backgroundColor.toUpperCase();
    el.backgroundHint.textContent =
        settings.colorMode === 'bw' && (settings.background === 'white' || settings.background === 'custom')
            ? 'Adds a vector background rectangle behind the black shapes.'
            : BACKGROUND_HINTS[settings.background];
    updateSettingsNote();
}

function updateSettingsNote() {
    if (!state.image) {
        el.settingsNote.textContent = '';
        return;
    }
    const { width, height } = state.image.meta;
    const size = processingSize(width, height, state.settings.maxSize);
    el.settingsNote.textContent = size.scaled
        ? `Traced at ${size.width} × ${size.height} px, output at ${width} × ${height}.`
        : `Traced at full resolution, ${width} × ${height} px.`;
}

function onSettingsInput(event) {
    const name = event.target.name;
    if (name === 'preset') {
        state.settings = applyPreset(readSettings(), event.target.value);
        writeSettings(state.settings);
    } else {
        state.settings = { ...readSettings(), preset: 'custom' };
        for (const radio of el.form.elements.preset) radio.checked = false;
        refreshSettingsUi();
    }
    if (state.result) el.staleNote.hidden = false;
}

/* ---------- conversion ---------- */

function setConverting(active) {
    state.converting = active;
    el.progress.hidden = !active;
    el.convertButton.disabled = active;
    el.convertButton.querySelector('span').textContent = active ? 'Converting…' : 'Convert to SVG';
    $('#replaceButton').disabled = active;
    $('#removeButton').disabled = active;
    el.form.setAttribute('aria-busy', String(active));
}

let elapsedTimer;
function setStage(stage) {
    el.progressStage.textContent = STAGES[stage] ?? STAGES.prepare;
}

function startElapsed(startedAt) {
    clearInterval(elapsedTimer);
    const tick = () => {
        el.progressHint.textContent = `Running locally in your browser · ${formatDuration(performance.now() - startedAt)}`;
    };
    tick();
    elapsedTimer = setInterval(tick, 250);
}

/** Lets the browser paint status changes; a timer (unlike rAF) also resolves in background tabs. */
const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 20));

async function buildVariant(text) {
    const validation = validateSvg(text);
    if (!validation.sanitized) return { text, validation, size: byteLength(text), url: null, reopens: false };
    const blob = svgBlob(validation.sanitized);
    const reopens = validation.valid ? await verifyReopen(blob) : false;
    return { text: validation.sanitized, validation, size: blob.size, url: URL.createObjectURL(blob), reopens };
}

async function convert() {
    if (!state.image || state.converting || vectorizer.busy) return;
    clearError();
    const settings = { ...state.settings };
    const { bitmap, meta } = state.image;
    const startedAt = performance.now();

    setConverting(true);
    setStage('prepare');
    startElapsed(startedAt);
    await yieldToBrowser();

    try {
        const raster = rasterize(bitmap, settings.maxSize);
        const response = await vectorizer.vectorize(
            { pixels: raster.data, width: raster.width, height: raster.height },
            settings,
            { width: meta.width, height: meta.height },
            setStage,
        );

        setStage('validate');
        await yieldToBrowser();
        const raw = await buildVariant(response.svg);
        if (!raw.validation.valid) {
            console.error('[VectorLab] Engine output failed validation', raw.validation.checks);
            if (raw.url) URL.revokeObjectURL(raw.url);
            throw Object.assign(new Error('invalid-svg'), {
                userMessage: 'The engine produced an SVG that failed validation, so it was discarded. Try different settings.',
            });
        }
        let optimized = response.optimized ? await buildVariant(response.optimized) : null;
        if (optimized && !optimized.validation.valid) {
            console.warn('[VectorLab] Optimized SVG failed validation; using unoptimized output', optimized.validation.checks);
            if (optimized.url) URL.revokeObjectURL(optimized.url);
            optimized = null;
        }

        releaseResult();
        state.result = {
            raw,
            optimized,
            optimizeError: response.optimizeError,
            warnings: response.warnings,
            engineOptions: response.engineOptions,
            trace: response.trace,
            timings: response.timings,
            duration: performance.now() - startedAt,
            settings,
        };
        state.variant = optimized ? 'optimized' : 'raw';
        showResult();
    } catch (error) {
        if (error instanceof CancelledError) {
            toast('Conversion cancelled');
        } else {
            console.error('[VectorLab] Conversion failed', error);
            showError(error.userMessage ?? toUserMessage(error, 'The conversion failed. Please try different settings.'));
        }
    } finally {
        clearInterval(elapsedTimer);
        setConverting(false);
    }
}

/* ---------- result display ---------- */

function currentVariant() {
    const { result } = state;
    return state.variant === 'optimized' && result.optimized ? result.optimized : result.raw;
}

function showVariant(variant) {
    state.variant = variant;
    setRadioGroup(el.variantToggle, 'variant', currentVariant() === state.result.optimized ? 'optimized' : 'raw');
    el.vectorImage.src = currentVariant().url;
}

function showResult() {
    const { result } = state;
    const { meta } = state.image;
    el.results.hidden = false;
    el.staleNote.hidden = true;
    $$('button', el.modeToggle).forEach((b) => (b.disabled = false));
    el.modeToggle.classList.remove('is-disabled');
    $$('[data-variant="optimized"]', el.variantToggle)[0].disabled = !result.optimized;
    $('#downloadOptimized').disabled = !result.optimized;

    showVariant(state.variant);
    if (comparison.mode === 'original') {
        comparison.setMode(state.lastCompareMode);
        setRadioGroup(el.modeToggle, 'mode', state.lastCompareMode);
    }

    const rawStats = result.raw.validation.stats;
    const saved = result.optimized ? 1 - result.optimized.size / result.raw.size : 0;
    el.resultsSubtitle.textContent = `${plural(rawStats.pathCount, 'vector path')} · ${plural(rawStats.colorCount, 'colour')} · ${formatDuration(result.duration)}`;

    const rows = [
        ['Original image', `${meta.width} × ${meta.height} px · ${formatBytes(meta.size)}`],
        ['Traced at', `${result.trace.width} × ${result.trace.height} px`],
        ['SVG dimensions', `${rawStats.width} × ${rawStats.height} · viewBox ${rawStats.viewBox.width} × ${rawStats.viewBox.height}`],
        ['SVG size', formatBytes(result.raw.size)],
        ['Optimized size', result.optimized ? `${formatBytes(result.optimized.size)} (${saved >= 0 ? '−' : '+'}${Math.abs(saved * 100).toFixed(1)}%)` : 'Unavailable'],
        ['Vector paths', formatNumber(rawStats.pathCount)],
        ['Fill colours', formatNumber(rawStats.colorCount)],
        ['Conversion time', `${formatDuration(result.duration)} (tracing ${formatDuration(result.timings.trace)})`],
    ];
    el.stats.replaceChildren(
        ...rows.flatMap(([label, value]) => {
            const dt = document.createElement('dt');
            dt.textContent = label;
            const dd = document.createElement('dd');
            dd.textContent = value;
            return [dt, dd];
        }),
    );

    const variants = [result.raw, result.optimized].filter(Boolean);
    const checks = result.raw.validation.checks.map((check) => ({
        label: check.label,
        ok: variants.every((v) => v.validation.checks.find((c) => c.id === check.id)?.ok),
        detail: check.detail,
    }));
    checks.push({ label: 'Downloadable file reopens and renders', ok: variants.every((v) => v.reopens) });
    if (!result.optimized) checks.push({ label: 'SVGO optimization', ok: false, detail: 'failed, unoptimized output kept' });
    el.checks.replaceChildren(
        ...checks.map((check) => {
            const li = document.createElement('li');
            li.className = check.ok ? 'is-ok' : 'is-fail';
            li.innerHTML = `<svg class="icon"><use href="#i-${check.ok ? 'check' : 'alert'}"/></svg><span></span>`;
            li.querySelector('span').textContent = check.detail ? `${check.label} — ${check.detail}` : check.label;
            return li;
        }),
    );

    const notes = [...result.warnings];
    if (rawStats.pathCount > 5000 || result.raw.size > 5 * 1024 * 1024) {
        notes.push('This result is very complex. Large SVGs can be slow to open in vector editors; try fewer colours, a lower detail level or a smaller processing size.');
    }
    el.warnings.hidden = notes.length === 0;
    el.warnings.textContent = notes.join(' ');
}

/* ---------- export ---------- */

function downloadVariant(which) {
    const variant = which === 'optimized' ? state.result.optimized : state.result.raw;
    if (!variant) return;
    const name = svgFileName(state.image.meta.name, which === 'optimized' ? '' : '-unoptimized');
    downloadBlob(svgBlob(variant.text), name);
    toast(`Downloading ${name}`);
}

async function copyVariant(variant) {
    try {
        await copyText(variant.text);
        toast(`Copied ${formatBytes(variant.size)} of SVG code`);
    } catch (error) {
        console.error('[VectorLab] Copy failed', error);
        toast('Copy failed — your browser blocked clipboard access');
    }
}

function sourceVariant() {
    return state.sourceVariant === 'optimized' && state.result.optimized ? state.result.optimized : state.result.raw;
}

function renderSource() {
    const variant = sourceVariant();
    setRadioGroup(el.sourceToggle, 'variant', variant === state.result.optimized ? 'optimized' : 'raw');
    el.sourceSize.textContent = formatBytes(variant.size);
    const truncated = variant.text.length > SOURCE_PREVIEW_LIMIT;
    el.sourceCode.textContent = truncated ? `${variant.text.slice(0, SOURCE_PREVIEW_LIMIT)}\n…` : variant.text;
    el.sourceNote.hidden = !truncated;
    el.sourceNote.textContent = truncated
        ? `Showing the first ${formatBytes(SOURCE_PREVIEW_LIMIT)} of ${formatBytes(variant.size)}. Copy and download include the full file.`
        : '';
}

function openSource() {
    state.sourceVariant = state.variant;
    $$('[data-variant="optimized"]', el.sourceToggle)[0].disabled = !state.result.optimized;
    renderSource();
    el.sourceDialog.showModal();
}

/* ---------- wiring ---------- */

function bindUpload() {
    el.browseButton.addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', () => handleFile(el.fileInput.files[0]));
    el.heroCta.addEventListener('click', (event) => {
        event.preventDefault();
        $('#tool').scrollIntoView({ behavior: 'smooth', block: 'start' });
        (el.workspace.hidden ? el.browseButton : el.convertButton).focus({ preventScroll: true });
    });
    el.dropzone.addEventListener('click', (event) => {
        if (event.target === el.dropzone) el.fileInput.click();
    });

    let dragDepth = 0;
    window.addEventListener('dragenter', (event) => {
        if (!event.dataTransfer?.types.includes('Files')) return;
        dragDepth += 1;
        document.body.classList.add('is-dragging');
    });
    window.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) document.body.classList.remove('is-dragging');
    });
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => {
        event.preventDefault();
        dragDepth = 0;
        document.body.classList.remove('is-dragging');
        const file = event.dataTransfer?.files?.[0];
        if (file) handleFile(file);
    });
    window.addEventListener('paste', (event) => {
        const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
        if (file) handleFile(file);
    });

    $('#replaceButton').addEventListener('click', () => el.fileInput.click());
    $('#removeButton').addEventListener('click', resetToUpload);
    $('#errorDismiss').addEventListener('click', clearError);
}

function bindViewer() {
    $('#zoomIn').addEventListener('click', () => viewer.zoomIn());
    $('#zoomOut').addEventListener('click', () => viewer.zoomOut());
    $('#zoomFit').addEventListener('click', () => viewer.fit());
    el.zoomLevel.addEventListener('click', () => viewer.actualSize());

    bindRadioGroup(el.modeToggle, 'mode', (mode) => {
        state.lastCompareMode = mode;
        setRadioGroup(el.modeToggle, 'mode', mode);
        comparison.setMode(mode);
    });
    bindRadioGroup(el.bgToggle, 'bg', (bg) => {
        setRadioGroup(el.bgToggle, 'bg', bg);
        el.compare.dataset.bg = bg;
    });
    bindRadioGroup(el.variantToggle, 'variant', showVariant);

    const fullscreen = $('#fullscreenButton');
    if (!document.fullscreenEnabled) fullscreen.hidden = true;
    fullscreen.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else el.viewer.requestFullscreen().catch((error) => console.warn('[VectorLab] Fullscreen unavailable', error));
    });
    document.addEventListener('fullscreenchange', () => {
        const active = document.fullscreenElement === el.viewer;
        fullscreen.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Fullscreen preview');
    });
}

function bindSettings() {
    buildPresets();
    state.settings = applyPreset({ ...DEFAULT_SETTINGS }, DEFAULT_SETTINGS.preset);
    writeSettings(state.settings);
    el.form.addEventListener('input', onSettingsInput);
    el.form.addEventListener('submit', (event) => {
        event.preventDefault();
        convert();
    });
    $('#cancelButton').addEventListener('click', () => vectorizer.cancel());
}

function bindExport() {
    $('#downloadOptimized').addEventListener('click', () => downloadVariant('optimized'));
    $('#downloadRaw').addEventListener('click', () => downloadVariant('raw'));
    $('#copyButton').addEventListener('click', () => copyVariant(currentVariant()));
    $('#sourceButton').addEventListener('click', openSource);
    bindRadioGroup(el.sourceToggle, 'variant', (variant) => {
        state.sourceVariant = variant;
        renderSource();
    });
    $('#sourceCopy').addEventListener('click', () => copyVariant(sourceVariant()));
    $('#sourceDownload').addEventListener('click', () => downloadVariant(sourceVariant() === state.result.optimized ? 'optimized' : 'raw'));
    $('#sourceClose').addEventListener('click', () => el.sourceDialog.close());
    el.sourceDialog.addEventListener('click', (event) => {
        if (event.target === el.sourceDialog) el.sourceDialog.close();
    });
}

bindUpload();
bindViewer();
bindSettings();
bindExport();
window.addEventListener('pagehide', () => vectorizer.dispose());
