/*
 * User settings, persisted to localStorage.
 *
 * The defaults are the ones that work for the common windshield setup: phone
 * lying face up on the dashboard, so the image has to be mirrored horizontally
 * before it bounces off the glass.
 */

const KEY = "hud-karaoke.settings";

export const DEFAULTS = {
    mirrorX: true, // windshield reflection reads back to front
    flipY: false, // for combiner glass / phone mounted upside down
    color: "cyan", // cyan | green | amber | white
    fontScale: 1, // 0.7 .. 1.8
    brightness: 1, // 0.35 .. 1, dims the whole stage at night
    glow: true, // soft bloom, helps thin reflections carry
    showNext: true, // preview of the upcoming line
    showProgress: true,
    keepAwake: true,
    driveLock: false, // arm the lock overlay whenever playback starts
    lockDelay: 8, // seconds of no touch before the lock engages
    tapSyncHint: true, // first-run explanation for the tap sync screen
    safetyAck: false, // driver acknowledged the safety notice
};

const NUMERIC = {
    fontScale: [0.7, 1.8],
    brightness: [0.35, 1],
    lockDelay: [3, 60],
};

function coerce(stored) {
    const settings = { ...DEFAULTS };
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
        if (!(key in stored)) {
            continue;
        }
        const value = stored[key];
        if (typeof fallback === "boolean") {
            settings[key] = Boolean(value);
        } else if (typeof fallback === "number") {
            const [low, high] = NUMERIC[key] || [-Infinity, Infinity];
            settings[key] = Number.isFinite(Number(value))
                ? Math.min(high, Math.max(low, Number(value)))
                : fallback;
        } else {
            settings[key] = String(value);
        }
    }
    return settings;
}

export function loadSettings() {
    try {
        const raw = localStorage.getItem(KEY);
        return raw ? coerce(JSON.parse(raw)) : { ...DEFAULTS };
    } catch (error) {
        return { ...DEFAULTS };
    }
}

export function saveSettings(settings) {
    try {
        localStorage.setItem(KEY, JSON.stringify(settings));
    } catch (error) {
        /* Private browsing or a full disk: the app still works, just forgets. */
    }
}
