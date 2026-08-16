/*
 * The HUD stage renderer.
 *
 * Deliberately spartan: on a windshield only bright pixels survive the
 * reflection, so the design is a black field with one very large active line,
 * a dim preview of what is coming, and a countdown for instrumental gaps.
 */

import { activeLineIndex, lineProgress, lineEnd, clamp, formatTime } from "./lrc.js";

const INTERLUDE_THRESHOLD = 3.5; // seconds of silence worth counting down
const MAX_DOTS = 8;

export class HudView {
    constructor(root) {
        this.root = root;
        this.titleEl = root.querySelector(".hud-title");
        this.prevEl = root.querySelector(".line-prev");
        this.baseEl = root.querySelector(".line-base");
        this.fillEl = root.querySelector(".line-fill");
        this.nextEl = root.querySelector(".line-next");
        this.interludeEl = root.querySelector(".hud-interlude");
        this.dotsEl = root.querySelector(".interlude-dots");
        this.countEl = root.querySelector(".interlude-count");
        this.barEl = root.querySelector(".progress-fill");
        this.elapsedEl = root.querySelector(".time-elapsed");
        this.remainEl = root.querySelector(".time-remaining");

        this.lines = [];
        this.synced = true;
        this.index = -2; // forces a first paint
        this.dotCount = -1;
    }

    setSong({ lines, synced, meta }) {
        this.lines = lines || [];
        this.synced = synced !== false;
        this.index = -2;
        this.dotCount = -1;
        const title = [meta && meta.title, meta && meta.artist].filter(Boolean).join(" — ");
        this.titleEl.textContent = title;
        this.titleEl.hidden = title === "";
    }

    /* Called from the animation loop with the current song position. */
    render(time, duration) {
        if (this.lines.length === 0) {
            return;
        }
        const index = this.synced ? activeLineIndex(this.lines, time) : this.index;

        if (index !== this.index) {
            this.index = index;
            this.paintLines(index);
        }

        if (this.synced) {
            const fill = index >= 0 ? lineProgress(this.lines, index, time) : 0;
            this.fillEl.style.setProperty("--fill", `${(fill * 100).toFixed(2)}%`);
            this.paintInterlude(index, time);
        }

        this.paintProgress(time, duration);
    }

    /** Manual line stepping, used by the unsynced and tap sync modes. */
    setIndex(index) {
        this.index = clamp(index, 0, Math.max(0, this.lines.length - 1));
        this.paintLines(this.index);
        this.fillEl.style.setProperty("--fill", "0%");
        return this.index;
    }

    paintLines(index) {
        const current = index >= 0 ? this.lines[index] : null;
        const previous = index > 0 ? this.lines[index - 1] : null;
        const next = this.lines[index + 1];

        const text = current ? current.text : "";
        this.baseEl.textContent = text;
        this.fillEl.textContent = text;
        this.prevEl.textContent = previous ? previous.text : "";
        this.nextEl.textContent = next ? next.text : "";

        /* Long lines get a smaller step so they still fit on one screen. */
        const length = text.length;
        const squeeze = length > 44 ? 0.62 : length > 30 ? 0.76 : length > 20 ? 0.88 : 1;
        this.root.style.setProperty("--line-squeeze", String(squeeze));

        this.root.classList.toggle("is-idle", current === null);
    }

    paintInterlude(index, time) {
        const next = this.lines[index + 1];
        const until = next ? next.time - time : Infinity;
        /* Only once the current line has been sung: otherwise the countdown
         * competes with the line the driver is still in the middle of. */
        const sung = index < 0 || time >= lineEnd(this.lines, index);
        const active = next !== undefined && sung && until > INTERLUDE_THRESHOLD;

        this.interludeEl.hidden = !active;
        /* While waiting, the line you are about to sing becomes the main one. */
        this.root.classList.toggle("is-break", active);
        if (!active) {
            this.dotCount = -1;
            return;
        }

        const seconds = Math.ceil(until);
        if (seconds !== this.dotCount) {
            this.dotCount = seconds;
            this.countEl.textContent = String(seconds);
            const dots = Math.min(seconds, MAX_DOTS);
            this.dotsEl.textContent = "•".repeat(dots);
        }
        this.interludeEl.classList.toggle("imminent", until <= 4);
    }

    paintProgress(time, duration) {
        const span = duration > 0 ? duration : this.songLength();
        const ratio = span > 0 ? clamp(time / span, 0, 1) : 0;
        this.barEl.style.transform = `scaleX(${ratio.toFixed(4)})`;
        this.elapsedEl.textContent = formatTime(time);
        this.remainEl.textContent = span > 0 ? `-${formatTime(span - time)}` : "";
    }

    songLength() {
        const last = this.lines[this.lines.length - 1];
        return last && last.time !== null ? last.time + 5 : 0;
    }
}

/**
 * Apply the visual settings to the stage.  Mirroring is done here and only
 * here: it is scoped to the stage element so the controls the driver actually
 * touches stay the right way round on the phone itself.
 */
export function applyLook(stage, settings) {
    const transforms = [];
    if (settings.mirrorX) {
        transforms.push("scaleX(-1)");
    }
    if (settings.flipY) {
        transforms.push("scaleY(-1)");
    }
    stage.style.transform = transforms.join(" ");
    stage.dataset.color = settings.color;
    stage.classList.toggle("no-glow", !settings.glow);
    stage.classList.toggle("hide-next", !settings.showNext);
    stage.classList.toggle("hide-progress", !settings.showProgress);
    stage.style.setProperty("--font-scale", String(settings.fontScale));
    stage.style.setProperty("--stage-brightness", String(settings.brightness));
}
