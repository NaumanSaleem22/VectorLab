import { clamp } from './utils.js';

const MIN_SCALE = 0.02;
const MAX_SCALE = 40;
const ZOOM_STEP = 1.25;
const FIT_PADDING = 0.92;

/**
 * Shared zoom/pan state for one or more viewports showing the same content size.
 *
 * Each stage is resized (not CSS-scaled) so the SVG is re-rendered as vectors
 * at every zoom level instead of being a scaled bitmap. All viewports share
 * one transform, which keeps side-by-side panes and the slider layers aligned.
 */
export class Viewer {
    #viewports;
    #stages;
    #content = { width: 1, height: 1 };
    #scale = 1;
    #x = 0;
    #y = 0;
    #onChange;
    #resizeObserver;

    constructor(viewports, { onChange } = {}) {
        this.#viewports = viewports;
        this.#stages = viewports.map((vp) => vp.querySelector('[data-stage]'));
        this.#onChange = onChange;
        viewports.forEach((vp) => this.#bindViewport(vp));
        this.#resizeObserver = new ResizeObserver(() => this.fit());
        viewports.forEach((vp) => this.#resizeObserver.observe(vp));
    }

    get scale() {
        return this.#scale;
    }

    setContentSize(width, height) {
        this.#content = { width, height };
        this.fit();
    }

    #activeViewport() {
        return this.#viewports.find((vp) => vp.offsetWidth > 0) ?? this.#viewports[0];
    }

    fit() {
        const vp = this.#activeViewport();
        const { clientWidth: w, clientHeight: h } = vp;
        if (!w || !h) return;
        this.#scale = clamp(Math.min(w / this.#content.width, h / this.#content.height) * FIT_PADDING, MIN_SCALE, MAX_SCALE);
        this.#x = (w - this.#content.width * this.#scale) / 2;
        this.#y = (h - this.#content.height * this.#scale) / 2;
        this.#render();
    }

    actualSize() {
        const vp = this.#activeViewport();
        this.zoomTo(1, vp.clientWidth / 2, vp.clientHeight / 2);
    }

    zoomBy(factor, cx, cy) {
        this.zoomTo(this.#scale * factor, cx, cy);
    }

    zoomTo(scale, cx, cy) {
        const vp = this.#activeViewport();
        const originX = cx ?? vp.clientWidth / 2;
        const originY = cy ?? vp.clientHeight / 2;
        const next = clamp(scale, MIN_SCALE, MAX_SCALE);
        const ratio = next / this.#scale;
        this.#x = originX - (originX - this.#x) * ratio;
        this.#y = originY - (originY - this.#y) * ratio;
        this.#scale = next;
        this.#render();
    }

    zoomIn() {
        this.zoomBy(ZOOM_STEP);
    }

    zoomOut() {
        this.zoomBy(1 / ZOOM_STEP);
    }

    panBy(dx, dy) {
        this.#x += dx;
        this.#y += dy;
        this.#render();
    }

    #render() {
        const width = this.#content.width * this.#scale;
        const height = this.#content.height * this.#scale;
        for (const stage of this.#stages) {
            stage.style.width = `${width}px`;
            stage.style.height = `${height}px`;
            stage.style.transform = `translate(${this.#x}px, ${this.#y}px)`;
        }
        this.#viewports.forEach((vp) => vp.classList.toggle('is-pixelated', this.#scale >= 2));
        this.#onChange?.(this.#scale);
    }

    #bindViewport(vp) {
        vp.addEventListener(
            'wheel',
            (event) => {
                event.preventDefault();
                const rect = vp.getBoundingClientRect();
                const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
                this.zoomBy(factor, event.clientX - rect.left, event.clientY - rect.top);
            },
            { passive: false },
        );

        const pointers = new Map();
        let pinchDistance = 0;
        vp.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || event.target.closest('[data-no-pan]')) return;
            vp.setPointerCapture(event.pointerId);
            pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
            vp.classList.add('is-panning');
        });
        vp.addEventListener('pointermove', (event) => {
            const previous = pointers.get(event.pointerId);
            if (!previous) return;
            const current = { x: event.clientX, y: event.clientY };
            pointers.set(event.pointerId, current);
            if (pointers.size === 2) {
                const [a, b] = [...pointers.values()];
                const distance = Math.hypot(a.x - b.x, a.y - b.y);
                if (pinchDistance) {
                    const rect = vp.getBoundingClientRect();
                    this.zoomBy(distance / pinchDistance, (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top);
                }
                pinchDistance = distance;
            } else {
                this.panBy(current.x - previous.x, current.y - previous.y);
            }
        });
        const release = (event) => {
            pointers.delete(event.pointerId);
            if (pointers.size < 2) pinchDistance = 0;
            if (!pointers.size) vp.classList.remove('is-panning');
        };
        vp.addEventListener('pointerup', release);
        vp.addEventListener('pointercancel', release);

        vp.addEventListener('keydown', (event) => {
            const step = event.shiftKey ? 120 : 40;
            const actions = {
                '+': () => this.zoomIn(),
                '=': () => this.zoomIn(),
                '-': () => this.zoomOut(),
                0: () => this.fit(),
                1: () => this.actualSize(),
                ArrowLeft: () => this.panBy(step, 0),
                ArrowRight: () => this.panBy(-step, 0),
                ArrowUp: () => this.panBy(0, step),
                ArrowDown: () => this.panBy(0, -step),
            };
            const action = actions[event.key];
            if (action) {
                event.preventDefault();
                action();
            }
        });
    }

    destroy() {
        this.#resizeObserver.disconnect();
    }
}
