/*
 * Playback clocks.
 *
 * The renderer only ever asks a clock for "where are we in the song".  That
 * lets the same lyric engine drive two very different setups: audio played by
 * the phone itself, and audio coming from somewhere else entirely (car radio,
 * a passenger's phone, streaming apps) where all we can do is run a stopwatch
 * and let the driver nudge it into place.
 */

class BaseClock extends EventTarget {
    constructor() {
        super();
        this.duration = 0;
    }

    get playing() {
        return false;
    }

    announce(type) {
        this.dispatchEvent(new Event(type));
    }
}

export class AudioClock extends BaseClock {
    constructor(audio) {
        super();
        this.audio = audio;
        this.audio.addEventListener("play", () => this.announce("statechange"));
        this.audio.addEventListener("pause", () => this.announce("statechange"));
        this.audio.addEventListener("ended", () => this.announce("ended"));
        this.audio.addEventListener("loadedmetadata", () => {
            this.duration = Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
            this.announce("durationchange");
        });
    }

    get time() {
        return this.audio.currentTime;
    }

    get playing() {
        return !this.audio.paused && !this.audio.ended;
    }

    async play() {
        await this.audio.play();
    }

    pause() {
        this.audio.pause();
    }

    seek(seconds) {
        this.audio.currentTime = Math.max(0, seconds);
        this.announce("seek");
    }

    nudge(seconds) {
        this.seek(this.time + seconds);
    }

    setRate(rate) {
        this.audio.playbackRate = rate;
    }

    release() {
        this.audio.pause();
        this.audio.removeAttribute("src");
        this.audio.load();
    }
}

/*
 * A stopwatch for the "audio comes from elsewhere" mode.  `origin` is the wall
 * clock moment that maps to song position zero, so nudging the sync is just
 * moving that origin around.
 */
export class VirtualClock extends BaseClock {
    constructor(duration = 0) {
        super();
        this.duration = duration;
        this.origin = 0;
        this.frozen = 0;
        this.running = false;
        this.rate = 1;
    }

    get time() {
        if (!this.running) {
            return this.frozen;
        }
        return this.frozen + ((performance.now() - this.origin) / 1000) * this.rate;
    }

    get playing() {
        return this.running;
    }

    async play() {
        if (this.running) {
            return;
        }
        this.origin = performance.now();
        this.running = true;
        this.announce("statechange");
    }

    pause() {
        if (!this.running) {
            return;
        }
        this.frozen = this.time;
        this.running = false;
        this.announce("statechange");
    }

    seek(seconds) {
        this.frozen = Math.max(0, seconds);
        this.origin = performance.now();
        this.announce("seek");
    }

    nudge(seconds) {
        this.seek(this.time + seconds);
    }

    setRate(rate) {
        this.frozen = this.time;
        this.origin = performance.now();
        this.rate = rate;
    }

    release() {
        this.pause();
    }
}
