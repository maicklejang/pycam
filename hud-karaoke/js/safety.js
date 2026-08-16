/*
 * Everything that keeps the app usable, and sane, in a moving car:
 * screen wake lock, fullscreen, orientation and the drive lock overlay that
 * swallows stray taps so a bump in the road cannot skip a track.
 */

let wakeLock = null;
let wakeWanted = false;

async function acquire() {
    if (!wakeWanted || wakeLock || !("wakeLock" in navigator)) {
        return;
    }
    try {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => {
            wakeLock = null;
        });
    } catch (error) {
        wakeLock = null; // denied, low battery, or not permitted from this state
    }
}

/* The lock is dropped whenever the tab is hidden, so take it again on return. */
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
        acquire();
    }
});

export function keepAwake(enabled) {
    wakeWanted = enabled;
    if (enabled) {
        acquire();
    } else if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
    }
}

export function wakeLockSupported() {
    return "wakeLock" in navigator;
}

export async function toggleFullscreen(element = document.documentElement) {
    try {
        if (document.fullscreenElement) {
            await document.exitFullscreen();
            return false;
        }
        await element.requestFullscreen({ navigationUI: "hide" });
        lockLandscape();
        return true;
    } catch (error) {
        return Boolean(document.fullscreenElement);
    }
}

/* Only works while fullscreen, and only on some browsers. Failure is fine. */
export function lockLandscape() {
    if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock("landscape").catch(() => {});
    }
}

/**
 * Drive lock: a full screen overlay that eats every tap.  Unlocking needs a
 * deliberate long press, which is hard to do by accident and easy to do at a
 * red light.
 */
export class DriveLock extends EventTarget {
    constructor(overlay, { holdMs = 1200 } = {}) {
        super();
        this.overlay = overlay;
        this.holdMs = holdMs;
        this.engaged = false;
        this.timer = 0;
        this.idleTimer = 0;
        this.idleSeconds = 0;
        this.autoArm = false;

        const ring = overlay.querySelector(".lock-ring");
        const start = (event) => {
            event.preventDefault();
            overlay.classList.add("holding");
            if (ring) {
                ring.style.transitionDuration = `${this.holdMs}ms`;
                ring.style.strokeDashoffset = "0";
            }
            this.timer = setTimeout(() => this.disengage(), this.holdMs);
        };
        const stop = () => {
            clearTimeout(this.timer);
            overlay.classList.remove("holding");
            if (ring) {
                ring.style.transitionDuration = "180ms";
                ring.style.strokeDashoffset = String(RING_LENGTH);
            }
        };

        overlay.addEventListener("pointerdown", start);
        overlay.addEventListener("pointerup", stop);
        overlay.addEventListener("pointercancel", stop);
        overlay.addEventListener("pointerleave", stop);
    }

    engage() {
        if (this.engaged) {
            return;
        }
        this.engaged = true;
        this.overlay.hidden = false;
        clearTimeout(this.idleTimer);
        this.dispatchEvent(new Event("change"));
    }

    disengage() {
        clearTimeout(this.timer);
        if (!this.engaged) {
            return;
        }
        this.engaged = false;
        this.overlay.hidden = true;
        this.overlay.classList.remove("holding");
        this.dispatchEvent(new Event("change"));
        this.noteActivity();
    }

    /** Arm auto locking after `seconds` without a touch. `0` disables it. */
    setAuto(enabled, seconds) {
        this.autoArm = Boolean(enabled);
        this.idleSeconds = seconds;
        this.noteActivity();
    }

    noteActivity() {
        clearTimeout(this.idleTimer);
        if (!this.autoArm || this.engaged || !this.idleSeconds) {
            return;
        }
        this.idleTimer = setTimeout(() => this.engage(), this.idleSeconds * 1000);
    }
}

export const RING_LENGTH = 264; // 2 * PI * r, matches the SVG in index.html
