import { clamp } from './utils.js';

/**
 * Switches between side-by-side and slider comparison and drives the slider.
 * In slider mode both viewports are stacked in the same box; the vector layer
 * is clipped in viewport space, so the divider stays put while zooming and panning.
 */
export class Comparison {
    #root;
    #vectorViewport;
    #handle;
    #position = 50;

    constructor(root, { onModeChange } = {}) {
        this.#root = root;
        this.#vectorViewport = root.querySelector('[data-viewport="vector"]');
        this.#handle = root.querySelector('[data-slider-handle]');
        this.onModeChange = onModeChange;
        this.#bindHandle();
        this.setPosition(50);
    }

    get mode() {
        return this.#root.dataset.mode;
    }

    setMode(mode) {
        if (mode === this.mode) return;
        this.#root.dataset.mode = mode;
        this.#applyClip();
        this.onModeChange?.(mode);
    }

    setPosition(percent) {
        this.#position = clamp(percent, 0, 100);
        this.#handle.style.left = `${this.#position}%`;
        this.#handle.setAttribute('aria-valuenow', String(Math.round(this.#position)));
        this.#handle.setAttribute('aria-valuetext', `${Math.round(this.#position)}% original visible`);
        this.#applyClip();
    }

    #applyClip() {
        this.#vectorViewport.style.clipPath = this.mode === 'slider' ? `inset(0 0 0 ${this.#position}%)` : '';
    }

    #bindHandle() {
        const handle = this.#handle;
        const fromEvent = (event) => {
            const rect = this.#root.querySelector('[data-compare-area]').getBoundingClientRect();
            return ((event.clientX - rect.left) / rect.width) * 100;
        };
        handle.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            event.stopPropagation();
            handle.setPointerCapture(event.pointerId);
            handle.classList.add('is-dragging');
        });
        handle.addEventListener('pointermove', (event) => {
            if (handle.hasPointerCapture(event.pointerId)) this.setPosition(fromEvent(event));
        });
        const stop = (event) => {
            if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
            handle.classList.remove('is-dragging');
        };
        handle.addEventListener('pointerup', stop);
        handle.addEventListener('pointercancel', stop);
        handle.addEventListener('keydown', (event) => {
            const step = event.shiftKey ? 10 : 2;
            const moves = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step };
            if (event.key in moves) {
                event.preventDefault();
                this.setPosition(this.#position + moves[event.key]);
            } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                this.setPosition(event.key === 'Home' ? 0 : 100);
            }
        });
    }
}
