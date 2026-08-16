/*
 * LRC parsing / serialisation.
 *
 * Supports the plain format ("[01:23.45]line") including several time tags on
 * a single line, the enhanced word level format ("[01:23.45]<01:23.45>word"),
 * the usual metadata tags and files that carry no timing at all.
 */

const META_LINE = /^\[(ti|ar|al|au|by|re|ve|length|offset):([^\]]*)\]$/i;
const TIME_TAG = /\[(\d{1,3}):([0-5]?\d(?:[.:]\d{1,3})?)\]/g;
const WORD_TAG = /<(\d{1,3}):([0-5]?\d(?:[.:]\d{1,3})?)>/g;

const META_KEYS = {
    ti: "title",
    ar: "artist",
    al: "album",
    au: "author",
    by: "editor",
    re: "tool",
    ve: "version",
};

/* "12.34" and "12:340" are both used in the wild for seconds and fraction. */
function toSeconds(minutes, rest) {
    return parseInt(minutes, 10) * 60 + parseFloat(rest.replace(":", "."));
}

function collectTags(source, pattern) {
    const tags = [];
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source)) !== null) {
        tags.push({ time: toSeconds(match[1], match[2]), start: match.index, end: pattern.lastIndex });
    }
    return tags;
}

/* Split "<0:01>ready<0:02>steady" into timed word chunks. */
function parseWords(text) {
    const tags = collectTags(text, WORD_TAG);
    if (tags.length === 0) {
        return null;
    }
    const words = [];
    tags.forEach((tag, index) => {
        const until = index + 1 < tags.length ? tags[index + 1].start : text.length;
        const chunk = text.slice(tag.end, until);
        if (chunk !== "") {
            words.push({ time: tag.time, text: chunk });
        }
    });
    /* Text in front of the first tag belongs to that first chunk. */
    const lead = text.slice(0, tags[0].start);
    if (lead.trim() !== "" && words.length > 0) {
        words[0] = { time: tags[0].time, text: lead + words[0].text };
    }
    return words.length > 0 ? words : null;
}

function stripTags(text) {
    return text.replace(WORD_TAG, "").trim();
}

/**
 * Parse an LRC (or plain lyrics) document.
 *
 * @param {string} source raw file content
 * @returns {{meta: object, lines: Array, synced: boolean}}
 */
export function parseLrc(source) {
    const meta = { title: "", artist: "", album: "", offset: 0 };
    const lines = [];
    const plain = [];

    for (const rawLine of String(source).replace(/\r\n?/g, "\n").split("\n")) {
        const line = rawLine.trim();
        if (line === "") {
            continue;
        }

        const metaMatch = line.match(META_LINE);
        if (metaMatch) {
            const key = metaMatch[1].toLowerCase();
            const value = metaMatch[2].trim();
            if (key === "offset") {
                /* The tag is in milliseconds and positive values play earlier. */
                const offset = parseFloat(value);
                meta.offset = Number.isFinite(offset) ? offset / 1000 : 0;
            } else if (key === "length") {
                meta.length = value;
            } else if (META_KEYS[key]) {
                meta[META_KEYS[key]] = value;
            }
            continue;
        }

        const times = collectTags(line, TIME_TAG);
        if (times.length === 0) {
            plain.push(line);
            continue;
        }

        const body = line.slice(times[times.length - 1].end);
        const words = parseWords(body);
        const text = stripTags(body);
        for (const tag of times) {
            lines.push({
                time: tag.time,
                text,
                words: words ? words.map((word) => ({ ...word })) : null,
            });
        }
    }

    if (lines.length === 0) {
        /* No timing at all: keep the text so it can still be shown or synced. */
        return {
            meta,
            synced: false,
            lines: plain.map((text) => ({ time: null, text, words: null })),
        };
    }

    lines.sort((a, b) => a.time - b.time);
    return { meta, synced: true, lines: applyOffset(lines, meta.offset) };
}

function applyOffset(lines, offset) {
    if (!offset) {
        return lines;
    }
    return lines.map((line) => ({
        ...line,
        time: Math.max(0, line.time - offset),
        words: line.words
            ? line.words.map((word) => ({ ...word, time: Math.max(0, word.time - offset) }))
            : null,
    }));
}

/**
 * Index of the line that is active at `time`, or -1 before the first line.
 * Binary search, so this is cheap enough to call on every animation frame.
 */
export function activeLineIndex(lines, time) {
    let low = 0;
    let high = lines.length - 1;
    let found = -1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (lines[middle].time <= time) {
            found = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return found;
}

/*
 * How long a line plausibly takes to sing.  LRC only records where lines
 * start, so the end has to be guessed: normally it is simply where the next
 * line begins, but that turns a ten second instrumental break into a wipe that
 * crawls across the screen.  Capping the guess at a generous reading speed
 * keeps ordinary lines untouched while letting real gaps be recognised as
 * gaps.  An empty line — the usual LRC marker for a break — ends at once.
 */
const SECONDS_PER_CHAR = 0.45;
const MIN_LINE_SECONDS = 2.5;
const GAP_FACTOR = 2; // a gap beyond this multiple of the sung length is a break

export function lineEnd(lines, index) {
    const line = lines[index];
    if (!line || line.time === null) {
        return 0;
    }
    const next = lines[index + 1];
    const characters = line.text.trim().length;
    if (characters === 0) {
        return line.time; // empty line: the conventional break marker
    }

    const natural = Math.max(MIN_LINE_SECONDS, characters * SECONDS_PER_CHAR);
    if (!next) {
        return line.time + natural;
    }
    /* Anything up to twice the plausible length is just a slowly sung line, so
     * the wipe keeps running to the next line exactly as a normal player does.
     * Only clearly longer silences are shortened into a break. */
    const gap = next.time - line.time;
    let end = gap <= natural * GAP_FACTOR ? next.time : line.time + natural;
    if (line.words && line.words.length > 0) {
        /* Never end before the last word the file itself timed. */
        end = Math.min(next.time, Math.max(end, line.words[line.words.length - 1].time + 0.4));
    }
    return end;
}

/**
 * How far the karaoke wipe has advanced through the active line, 0..1.
 * Word level timing is used when the line carries it, otherwise the wipe is
 * spread evenly over the line's duration.
 */
export function lineProgress(lines, index, time) {
    const line = lines[index];
    if (!line || line.time === null) {
        return 0;
    }
    const end = lineEnd(lines, index);

    if (line.words && line.words.length > 0) {
        const total = line.text.length || 1;
        let consumed = 0;
        for (let i = 0; i < line.words.length; i++) {
            const word = line.words[i];
            const wordEnd = i + 1 < line.words.length ? line.words[i + 1].time : end;
            if (time < word.time) {
                break;
            }
            if (time >= wordEnd) {
                consumed += word.text.length;
                continue;
            }
            const span = Math.max(wordEnd - word.time, 0.001);
            consumed += word.text.length * ((time - word.time) / span);
            break;
        }
        return clamp(consumed / total, 0, 1);
    }

    const span = Math.max(end - line.time, 0.001);
    return clamp((time - line.time) / span, 0, 1);
}

/** Seconds of silence in front of `index`, used for the interlude countdown. */
export function gapBefore(lines, index) {
    if (index <= 0) {
        return lines.length > 0 && lines[0].time !== null ? lines[0].time : 0;
    }
    const previous = lines[index - 1];
    return lines[index].time - previous.time;
}

export function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
}

export function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        seconds = 0;
    }
    const whole = Math.floor(seconds);
    const minutes = Math.floor(whole / 60);
    return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

function stamp(seconds) {
    const safe = Math.max(0, seconds);
    const minutes = Math.floor(safe / 60);
    const rest = safe - minutes * 60;
    return `[${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}]`;
}

/** Build an .lrc document, used to export the result of the tap sync mode. */
export function serialiseLrc(lines, meta = {}) {
    const head = [];
    if (meta.title) {
        head.push(`[ti:${meta.title}]`);
    }
    if (meta.artist) {
        head.push(`[ar:${meta.artist}]`);
    }
    head.push("[re:HUD Karaoke]");
    const body = lines
        .filter((line) => line.time !== null)
        .map((line) => `${stamp(line.time)}${line.text}`);
    return head.concat(body).join("\n") + "\n";
}
