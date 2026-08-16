/*
 * HUD karaoke — application wiring.
 */

import { parseLrc, serialiseLrc, formatTime, clamp } from "./lrc.js";
import { AudioClock, VirtualClock } from "./clock.js";
import { HudView, applyLook } from "./hudview.js";
import * as library from "./library.js";
import { loadSettings, saveSettings, DEFAULTS } from "./settings.js";
import { keepAwake, wakeLockSupported, toggleFullscreen, DriveLock } from "./safety.js";

const $ = (selector) => document.querySelector(selector);

const stage = $("#stage");
const audio = $("#audio");
const controls = $("#controls");
const panel = $("#panel");
const toastEl = $("#toast");

const view = new HudView(stage);
const driveLock = new DriveLock($("#lock"));

/* One audio clock for the lifetime of the page: the <audio> element is shared,
 * so re-wrapping it per song would stack duplicate listeners on it. */
const audioClock = new AudioClock(audio);

let settings = loadSettings();

const state = {
    song: null, // { id?, title, artist, lrcText, audioBlob }
    parsed: { meta: {}, lines: [], synced: true },
    clock: new VirtualClock(0),
    audioUrl: null,
    lyricOffset: 0, // positive: lyrics appear later than the audio
    frame: 0,
    hideTimer: 0,
    toastTimer: 0,
    pending: { audioFile: null, lyricsFile: null, lyricsText: "" },
    tap: null,
};

/* ------------------------------------------------------------------ utils */

function toast(message, ms = 1800) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
        toastEl.hidden = true;
    }, ms);
}

function persist() {
    saveSettings(settings);
}

/* ------------------------------------------------------------- song loading */

function onClockEnded() {
    paintPlayButton();
    driveLock.disengage();
}

/* Point `state.clock` at a new source, moving the listeners across with it. */
function useClock(clock) {
    if (state.clock) {
        state.clock.removeEventListener("statechange", paintPlayButton);
        state.clock.removeEventListener("ended", onClockEnded);
    }
    state.clock = clock;
    clock.addEventListener("statechange", paintPlayButton);
    clock.addEventListener("ended", onClockEnded);
}

function releaseSong() {
    cancelAnimationFrame(state.frame);
    if (state.clock) {
        state.clock.pause();
    }
    if (state.audioUrl) {
        audio.removeAttribute("src");
        audio.load();
        URL.revokeObjectURL(state.audioUrl);
        state.audioUrl = null;
    }
}

async function loadSong(song, { autoplay = false } = {}) {
    releaseSong();

    const parsed = parseLrc(song.lrcText || "");
    parsed.meta.title = song.title || parsed.meta.title;
    parsed.meta.artist = song.artist || parsed.meta.artist;

    state.song = song;
    state.parsed = parsed;
    state.lyricOffset = Number(song.offset) || 0;
    view.setSong(parsed);

    if (song.audioBlob) {
        state.audioUrl = URL.createObjectURL(song.audioBlob);
        audio.src = state.audioUrl;
        useClock(audioClock);
    } else {
        /* No audio of our own: run a stopwatch as long as the lyrics last. */
        useClock(new VirtualClock(view.songLength()));
    }
    state.clock.seek(0);

    stage.classList.add("has-song");
    if (!parsed.synced) {
        view.setIndex(0);
        toast("싱크 없는 가사입니다 — 줄 버튼으로 넘기거나 탭 싱크를 쓰세요", 3200);
    }
    renderOnce();
    paintPlayButton();
    renderLibrary();

    if (autoplay) {
        await play();
    }
}

async function play() {
    try {
        await state.clock.play();
    } catch (error) {
        toast("재생할 수 없습니다 — 화면을 한 번 더 눌러 주세요");
        return;
    }
    if (settings.driveLock) {
        driveLock.setAuto(true, settings.lockDelay);
        driveLock.noteActivity();
    }
    loop();
}

function togglePlay() {
    if (!state.song) {
        openPanel("songs");
        return;
    }
    if (state.clock.playing) {
        state.clock.pause();
        renderOnce();
    } else {
        play();
    }
}

function paintPlayButton() {
    const glyph = $("#btn-play .glyph");
    const playing = state.clock.playing;
    glyph.textContent = playing ? glyph.dataset.pause : glyph.dataset.play;
    $("#btn-play").setAttribute("aria-label", playing ? "일시정지" : "재생");
}

/* --------------------------------------------------------------- rendering */

function renderTime() {
    return Math.max(0, state.clock.time - state.lyricOffset);
}

function renderOnce() {
    view.render(renderTime(), state.clock.duration);
}

function loop() {
    cancelAnimationFrame(state.frame);
    const tick = () => {
        renderOnce();
        if (state.clock.playing) {
            state.frame = requestAnimationFrame(tick);
        }
    };
    state.frame = requestAnimationFrame(tick);
}

/* ----------------------------------------------------------------- controls */

function stepLine(delta) {
    const lines = state.parsed.lines;
    if (lines.length === 0) {
        return;
    }
    if (!state.parsed.synced) {
        view.setIndex(view.index + delta);
        return;
    }
    const target = clamp(view.index + delta, 0, lines.length - 1);
    /* Land slightly before the line so the wipe starts from zero. */
    state.clock.seek(lines[target].time + state.lyricOffset - 0.15);
    renderOnce();
}

function nudgeLyrics(delta) {
    state.lyricOffset = clamp(state.lyricOffset + delta, -30, 30);
    const shown = state.lyricOffset >= 0 ? `+${state.lyricOffset.toFixed(1)}` : state.lyricOffset.toFixed(1);
    toast(`가사 싱크 ${shown}s`);
    renderOnce();
    if (state.song && state.song.id) {
        library.saveSong({ ...state.song, offset: state.lyricOffset }).catch(() => {});
    }
}

function setMirror(enabled) {
    settings.mirrorX = enabled;
    $("#set-mirrorX").checked = enabled;
    $("#btn-mirror").setAttribute("aria-pressed", String(enabled));
    applyLook(stage, settings);
    persist();
}

function showControls() {
    controls.classList.remove("is-hidden");
    clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(() => {
        if (state.clock.playing && panel.hidden && $("#tapsync").hidden) {
            controls.classList.add("is-hidden");
        }
    }, 4500);
}

/* ------------------------------------------------------------------ panel */

function openPanel(tab) {
    panel.hidden = false;
    if (tab) {
        selectTab(tab);
    }
    renderLibrary();
    showControls();
}

function selectTab(name) {
    for (const tab of document.querySelectorAll(".tab")) {
        tab.classList.toggle("is-active", tab.dataset.tab === name);
    }
    for (const page of document.querySelectorAll(".tab-page")) {
        page.classList.toggle("is-active", page.dataset.page === name);
    }
}

async function renderLibrary() {
    const list = $("#song-list");
    let songs = [];
    try {
        songs = await library.listSongs();
    } catch (error) {
        list.innerHTML = '<li class="empty-hint">보관함을 열 수 없습니다.</li>';
        return;
    }

    if (songs.length === 0) {
        list.innerHTML = '<li class="empty-hint">저장된 곡이 없습니다. 위에서 파일을 고르고 저장하세요.</li>';
    } else {
        list.innerHTML = "";
        for (const song of songs) {
            list.appendChild(songRow(song));
        }
    }

    const usage = await library.usage();
    $("#lib-usage").textContent = usage && usage.used
        ? `· ${(usage.used / 1048576).toFixed(0)}MB 사용`
        : "";
}

function songRow(song) {
    const item = document.createElement("li");
    item.className = "song-item";
    if (state.song && state.song.id === song.id) {
        item.classList.add("is-current");
    }

    const main = document.createElement("button");
    main.type = "button";
    main.className = "song-main";
    const parsed = parseLrc(song.lrcText || "");
    const flags = [
        song.audioBlob ? "음원" : "외부 오디오",
        parsed.synced ? "싱크됨" : "싱크 없음",
    ];
    main.innerHTML = `<span class="song-name"></span><span class="song-meta"></span>`;
    main.querySelector(".song-name").textContent = song.title || "제목 없음";
    main.querySelector(".song-meta").textContent =
        [song.artist, ...flags].filter(Boolean).join(" · ");
    main.addEventListener("click", async () => {
        await loadSong(song, { autoplay: false });
        panel.hidden = true;
        toast(`${song.title || "곡"} 불러옴`);
    });

    const syncBtn = document.createElement("button");
    syncBtn.type = "button";
    syncBtn.className = "icon-btn";
    syncBtn.textContent = "탭";
    syncBtn.title = "탭 싱크";
    syncBtn.addEventListener("click", async () => {
        await loadSong(song);
        panel.hidden = true;
        openTapSync();
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn";
    del.textContent = "삭제";
    del.addEventListener("click", async () => {
        if (!confirm(`"${song.title || "곡"}"을(를) 삭제할까요?`)) {
            return;
        }
        await library.deleteSong(song.id);
        renderLibrary();
    });

    item.append(main, syncBtn, del);
    return item;
}

/* --------------------------------------------------------- adding a song */

function readText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error);
        /* LRC files in the wild are frequently UTF-8, which covers Hangul. */
        reader.readAsText(file, "utf-8");
    });
}

function baseName(name) {
    return name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim();
}

function draftSong() {
    const title = $("#in-title").value.trim();
    const artist = $("#in-artist").value.trim();
    return {
        title: title || (state.pending.audioFile ? baseName(state.pending.audioFile.name) : "제목 없음"),
        artist,
        lrcText: state.pending.lyricsText,
        audioBlob: state.pending.audioFile || null,
        offset: 0,
    };
}

function resetDraft() {
    state.pending = { audioFile: null, lyricsFile: null, lyricsText: "" };
    $("#in-audio").value = "";
    $("#in-lyrics").value = "";
    $("#in-title").value = "";
    $("#in-artist").value = "";
    $("#audio-name").textContent = "mp3 · m4a · wav — 선택 안 하면 외부 오디오 모드";
    $("#lyrics-name").textContent = ".lrc(싱크) 또는 .txt(일반)";
}

/* -------------------------------------------------------------- tap sync */

function openTapSync() {
    const lines = state.parsed.lines;
    if (lines.length === 0) {
        toast("먼저 가사를 불러오세요");
        return;
    }
    state.tap = { index: 0, times: new Array(lines.length).fill(null) };
    $("#tapsync").hidden = false;
    $("#tapsync-hint").hidden = !settings.tapSyncHint;
    paintTapSync();
    if (!state.clock.playing) {
        play();
    }
    tapSyncClock();
}

function tapSyncClock() {
    if ($("#tapsync").hidden) {
        return;
    }
    $("#tapsync-time").textContent = formatTime(state.clock.time);
    requestAnimationFrame(tapSyncClock);
}

function paintTapSync() {
    const { lines } = state.parsed;
    const { index } = state.tap;
    $("#tapsync-prev").textContent = index > 0 ? lines[index - 1].text : "";
    $("#tapsync-now").textContent = index < lines.length ? lines[index].text : "— 끝 —";
    $("#tapsync-next").textContent = index + 1 < lines.length ? lines[index + 1].text : "";
    $("#tapsync-hit").disabled = index >= lines.length;
}

function tapMark() {
    const { lines } = state.parsed;
    const tap = state.tap;
    if (!tap || tap.index >= lines.length) {
        return;
    }
    tap.times[tap.index] = state.clock.time;
    tap.index += 1;
    paintTapSync();
    if (navigator.vibrate) {
        navigator.vibrate(12);
    }
}

function tapUndo() {
    const tap = state.tap;
    if (!tap || tap.index === 0) {
        return;
    }
    tap.index -= 1;
    tap.times[tap.index] = null;
    paintTapSync();
}

async function tapSave() {
    const tap = state.tap;
    if (!tap || tap.times.every((time) => time === null)) {
        toast("아직 찍은 줄이 없습니다");
        return;
    }
    const lines = state.parsed.lines.map((line, index) => ({
        text: line.text,
        time: tap.times[index],
    }));
    const meta = state.parsed.meta;
    const lrcText = serialiseLrc(lines, meta);

    const song = { ...(state.song || {}), lrcText, offset: 0 };
    const saved = await library.saveSong(song);
    state.song = saved;
    await loadSong(saved);
    closeTapSync();
    const filename = safeFilename(meta.title);
    downloadLrc(lrcText, filename);
    toast(`싱크 저장 완료 — ${filename} 내려받음`, 3000);
}

/*
 * Browsers quietly drop a download name that is not plain ASCII and save the
 * file as "download" with no extension, so a Hangul title falls back to a
 * timestamp.  The real title is inside the file as a [ti:] tag either way.
 */
function safeFilename(title) {
    const ascii = String(title || "")
        .replace(/[^\w.\- ]+/g, "")
        .trim()
        .replace(/\s+/g, "_");
    if (ascii.length >= 2) {
        return `${ascii}.lrc`;
    }
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return `lyrics-${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.lrc`;
}

function downloadLrc(text, filename) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    /* Some browsers ignore the download name on a detached anchor. */
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function closeTapSync() {
    $("#tapsync").hidden = true;
    state.tap = null;
    state.clock.pause();
    renderOnce();
}

/* ------------------------------------------------------------------ setup */

function bindSettingControls() {
    const toggles = ["mirrorX", "flipY", "glow", "showNext", "showProgress", "keepAwake", "driveLock"];
    for (const key of toggles) {
        const input = $(`#set-${key}`);
        input.checked = Boolean(settings[key]);
        input.addEventListener("change", () => {
            settings[key] = input.checked;
            if (key === "keepAwake") {
                keepAwake(input.checked);
            }
            if (key === "driveLock") {
                driveLock.setAuto(input.checked && state.clock.playing, settings.lockDelay);
            }
            if (key === "mirrorX") {
                $("#btn-mirror").setAttribute("aria-pressed", String(input.checked));
            }
            applyLook(stage, settings);
            persist();
        });
    }

    for (const key of ["fontScale", "brightness", "lockDelay"]) {
        const input = $(`#set-${key}`);
        input.value = String(settings[key]);
        input.addEventListener("input", () => {
            settings[key] = Number(input.value);
            if (key === "lockDelay") {
                $("#lock-delay-value").textContent = String(settings.lockDelay);
                driveLock.setAuto(settings.driveLock && state.clock.playing, settings.lockDelay);
            }
            applyLook(stage, settings);
            persist();
        });
    }
    $("#lock-delay-value").textContent = String(settings.lockDelay);

    for (const swatch of document.querySelectorAll(".swatch")) {
        swatch.addEventListener("click", () => {
            settings.color = swatch.dataset.color;
            paintSwatches();
            applyLook(stage, settings);
            persist();
        });
    }
    paintSwatches();

    $("#wakelock-note").textContent = wakeLockSupported()
        ? "이 브라우저는 화면 항상 켜기를 지원합니다."
        : "이 브라우저는 Wake Lock을 지원하지 않습니다. 기기 설정에서 화면 꺼짐 시간을 늘려 주세요.";
}

function paintSwatches() {
    for (const swatch of document.querySelectorAll(".swatch")) {
        swatch.classList.toggle("is-active", swatch.dataset.color === settings.color);
    }
}

function bindControls() {
    $("#btn-play").addEventListener("click", togglePlay);
    $("#btn-prev").addEventListener("click", () => stepLine(-1));
    $("#btn-next").addEventListener("click", () => stepLine(1));
    $("#btn-back").addEventListener("click", () => {
        state.clock.nudge(-5);
        renderOnce();
    });
    $("#btn-forward").addEventListener("click", () => {
        state.clock.nudge(5);
        renderOnce();
    });
    $("#btn-sync-back").addEventListener("click", () => nudgeLyrics(-0.3));
    $("#btn-sync-fwd").addEventListener("click", () => nudgeLyrics(0.3));
    $("#btn-mirror").addEventListener("click", () => setMirror(!settings.mirrorX));
    $("#btn-lock").addEventListener("click", () => driveLock.engage());
    $("#btn-full").addEventListener("click", () => toggleFullscreen());
    $("#btn-panel").addEventListener("click", () => openPanel("songs"));
    $("#btn-panel-close").addEventListener("click", () => {
        panel.hidden = true;
    });

    for (const tab of document.querySelectorAll(".tab")) {
        tab.addEventListener("click", () => selectTab(tab.dataset.tab));
    }

    $("#in-audio").addEventListener("change", (event) => {
        const file = event.target.files[0];
        state.pending.audioFile = file || null;
        $("#audio-name").textContent = file ? file.name : "선택 안 함 — 외부 오디오 모드";
        if (file && !$("#in-title").value) {
            $("#in-title").value = baseName(file.name);
        }
    });

    $("#in-lyrics").addEventListener("change", async (event) => {
        const file = event.target.files[0];
        if (!file) {
            return;
        }
        try {
            state.pending.lyricsText = await readText(file);
        } catch (error) {
            toast("가사 파일을 읽지 못했습니다");
            return;
        }
        const parsed = parseLrc(state.pending.lyricsText);
        $("#lyrics-name").textContent =
            `${file.name} · ${parsed.lines.length}줄 · ${parsed.synced ? "싱크됨" : "싱크 없음"}`;
        if (!$("#in-title").value && parsed.meta.title) {
            $("#in-title").value = parsed.meta.title;
        }
        if (!$("#in-artist").value && parsed.meta.artist) {
            $("#in-artist").value = parsed.meta.artist;
        }
    });

    $("#btn-play-now").addEventListener("click", async () => {
        if (!state.pending.lyricsText) {
            toast("가사 파일을 먼저 고르세요");
            return;
        }
        await loadSong(draftSong());
        panel.hidden = true;
    });

    $("#btn-save-song").addEventListener("click", async () => {
        if (!state.pending.lyricsText) {
            toast("가사 파일을 먼저 고르세요");
            return;
        }
        try {
            const saved = await library.saveSong(draftSong());
            await library.requestPersistence();
            resetDraft();
            await renderLibrary();
            toast(`"${saved.title}" 저장됨`);
        } catch (error) {
            toast("저장 실패 — 저장 공간을 확인하세요");
        }
    });

    $("#btn-demo").addEventListener("click", loadDemo);

    $("#btn-reset").addEventListener("click", () => {
        if (!confirm("화면·주행 설정을 기본값으로 되돌릴까요? 저장된 곡은 유지됩니다.")) {
            return;
        }
        settings = { ...DEFAULTS, safetyAck: true };
        persist();
        location.reload();
    });

    $("#tapsync-hit").addEventListener("click", tapMark);
    $("#tapsync-undo").addEventListener("click", tapUndo);
    $("#tapsync-save").addEventListener("click", tapSave);
    $("#tapsync-exit").addEventListener("click", () => {
        settings.tapSyncHint = false;
        persist();
        closeTapSync();
    });

    $("#safety-ok").addEventListener("click", () => {
        settings.safetyAck = true;
        persist();
        $("#safety").hidden = true;
    });

    document.addEventListener("pointerdown", () => {
        showControls();
        driveLock.noteActivity();
    });

    document.addEventListener("keydown", (event) => {
        if (event.target.matches("input, textarea")) {
            return;
        }
        const actions = {
            " ": togglePlay,
            ArrowLeft: () => state.clock.nudge(-5),
            ArrowRight: () => state.clock.nudge(5),
            ArrowUp: () => stepLine(-1),
            ArrowDown: () => stepLine(1),
            m: () => setMirror(!settings.mirrorX),
            f: () => toggleFullscreen(),
            l: () => driveLock.engage(),
        };
        const action = actions[event.key] || actions[event.key.toLowerCase()];
        if (action) {
            event.preventDefault();
            action();
            renderOnce();
        }
    });

    driveLock.addEventListener("change", () => {
        controls.classList.toggle("is-hidden", driveLock.engaged);
    });
}

async function loadDemo() {
    try {
        const response = await fetch("songs/demo.lrc");
        const lrcText = await response.text();
        await loadSong({ title: "야간 주행", artist: "데모", lrcText, audioBlob: null });
        panel.hidden = true;
        toast("데모: 음원 없이 가사만 흐릅니다", 2600);
    } catch (error) {
        toast("데모를 불러오지 못했습니다");
    }
}

function boot() {
    applyLook(stage, settings);
    bindSettingControls();
    bindControls();
    setMirror(settings.mirrorX);
    keepAwake(settings.keepAwake);
    $("#safety").hidden = settings.safetyAck;
    showControls();
    renderLibrary();

    if ("serviceWorker" in navigator) {
        window.addEventListener("load", () => {
            navigator.serviceWorker.register("sw.js").catch(() => {});
        });
    }
}

boot();
