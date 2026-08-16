/* Run with: node --test hud-karaoke/tests/ */

import test from "node:test";
import assert from "node:assert/strict";

import {
    parseLrc,
    activeLineIndex,
    lineProgress,
    lineEnd,
    gapBefore,
    formatTime,
    serialiseLrc,
} from "../js/lrc.js";

test("parses metadata and timed lines", () => {
    const { meta, lines, synced } = parseLrc(
        "[ti:야간 주행]\n[ar:테스터]\n[00:01.50]첫 줄\n[00:04.00]둘째 줄\n"
    );
    assert.equal(synced, true);
    assert.equal(meta.title, "야간 주행");
    assert.equal(meta.artist, "테스터");
    assert.equal(lines.length, 2);
    assert.equal(lines[0].time, 1.5);
    assert.equal(lines[0].text, "첫 줄");
    assert.equal(lines[1].time, 4);
});

test("expands repeated time tags on one line and keeps the order", () => {
    const { lines } = parseLrc("[00:30.00][01:10.00]후렴\n[00:45.00]브리지\n");
    assert.deepEqual(
        lines.map((line) => [line.time, line.text]),
        [
            [30, "후렴"],
            [45, "브리지"],
            [70, "후렴"],
        ]
    );
});

test("accepts a colon before the fraction", () => {
    const { lines } = parseLrc("[00:12:50]반가워\n");
    assert.equal(lines[0].time, 12.5);
});

test("shifts every timestamp by the offset tag", () => {
    /* A positive offset means the lyrics should show up earlier. */
    const { lines } = parseLrc("[offset:+500]\n[00:10.00]가사\n");
    assert.equal(lines[0].time, 9.5);
});

test("never produces a negative timestamp from an offset", () => {
    const { lines } = parseLrc("[offset:+5000]\n[00:01.00]가사\n");
    assert.equal(lines[0].time, 0);
});

test("parses word level tags", () => {
    const { lines } = parseLrc("[00:01.00]<00:01.00>안녕 <00:02.00>하세요\n");
    assert.equal(lines[0].text, "안녕 하세요");
    assert.deepEqual(
        lines[0].words.map((word) => [word.time, word.text]),
        [
            [1, "안녕 "],
            [2, "하세요"],
        ]
    );
});

test("treats a file without timestamps as unsynced lyrics", () => {
    const parsed = parseLrc("첫 줄\n\n둘째 줄\n");
    assert.equal(parsed.synced, false);
    assert.deepEqual(parsed.lines.map((line) => line.text), ["첫 줄", "둘째 줄"]);
    assert.equal(parsed.lines[0].time, null);
});

test("keeps empty timed lines as silent placeholders", () => {
    const { lines } = parseLrc("[00:01.00]가사\n[00:05.00]\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[1].text, "");
});

test("activeLineIndex finds the line in effect", () => {
    const lines = [{ time: 0 }, { time: 10 }, { time: 20 }];
    assert.equal(activeLineIndex(lines, -1), -1);
    assert.equal(activeLineIndex(lines, 0), 0);
    assert.equal(activeLineIndex(lines, 9.99), 0);
    assert.equal(activeLineIndex(lines, 10), 1);
    assert.equal(activeLineIndex(lines, 999), 2);
});

test("lineProgress wipes evenly across the gap to the next line", () => {
    const lines = [
        { time: 0, text: "abcd", words: null },
        { time: 4, text: "efgh", words: null },
    ];
    assert.equal(lineProgress(lines, 0, 0), 0);
    assert.equal(lineProgress(lines, 0, 2), 0.5);
    assert.equal(lineProgress(lines, 0, 4), 1);
});

test("lineEnd normally runs up to the next line", () => {
    const lines = [
        { time: 0, text: "짧은 가사 한 줄", words: null },
        { time: 4, text: "다음", words: null },
    ];
    assert.equal(lineEnd(lines, 0), 4);
});

test("lineEnd caps a line at a plausible singing length before a long break", () => {
    /* A 30 second gap is an instrumental, not a very slowly sung line. */
    const lines = [
        { time: 0, text: "네 글자", words: null },
        { time: 30, text: "다음", words: null },
    ];
    const end = lineEnd(lines, 0);
    assert.ok(end > 0 && end < 6, `unexpected line end ${end}`);
});

test("lineEnd treats an empty line as an immediate break marker", () => {
    const lines = [{ time: 10, text: "", words: null }, { time: 25, text: "다음" }];
    assert.equal(lineEnd(lines, 0), 10);
});

test("lineEnd never cuts a word timed line short of its last word", () => {
    const lines = [
        {
            time: 0,
            text: "가",
            words: [{ time: 0, text: "가" }, { time: 8, text: "" }],
        },
        { time: 20, text: "다음" },
    ];
    assert.ok(lineEnd(lines, 0) >= 8);
});

test("the wipe completes during an instrumental instead of crawling", () => {
    const lines = [
        { time: 0, text: "한 줄", words: null },
        { time: 30, text: "다음", words: null },
    ];
    assert.equal(lineProgress(lines, 0, 3), 1);
});

test("lineProgress follows word timings when present", () => {
    const lines = [
        {
            time: 0,
            text: "aabb",
            words: [
                { time: 0, text: "aa" },
                { time: 2, text: "bb" },
            ],
        },
        { time: 4, text: "cc", words: null },
    ];
    assert.equal(lineProgress(lines, 0, 0), 0);
    assert.equal(lineProgress(lines, 0, 1), 0.25); // half of the first word
    assert.equal(lineProgress(lines, 0, 2), 0.5);
    assert.equal(lineProgress(lines, 0, 3), 0.75);
});

test("lineProgress stays inside 0..1 past the end of the last line", () => {
    const lines = [{ time: 0, text: "abc", words: null }];
    assert.equal(lineProgress(lines, 0, 500), 1);
});

test("gapBefore measures the silence in front of a line", () => {
    const lines = [{ time: 3 }, { time: 8 }];
    assert.equal(gapBefore(lines, 0), 3);
    assert.equal(gapBefore(lines, 1), 5);
});

test("formatTime pads seconds and clamps negatives", () => {
    assert.equal(formatTime(0), "0:00");
    assert.equal(formatTime(9.7), "0:09");
    assert.equal(formatTime(75), "1:15");
    assert.equal(formatTime(-3), "0:00");
});

test("serialise then parse round trips the timings", () => {
    const lines = [
        { time: 1.5, text: "첫 줄" },
        { time: 65.25, text: "둘째 줄" },
    ];
    const text = serialiseLrc(lines, { title: "제목", artist: "가수" });
    const parsed = parseLrc(text);
    assert.equal(parsed.meta.title, "제목");
    assert.equal(parsed.meta.artist, "가수");
    assert.deepEqual(
        parsed.lines.map((line) => [line.time, line.text]),
        [
            [1.5, "첫 줄"],
            [65.25, "둘째 줄"],
        ]
    );
});

test("serialise skips lines that were never tapped", () => {
    const text = serialiseLrc([{ time: null, text: "안 찍음" }, { time: 2, text: "찍음" }]);
    assert.ok(!text.includes("안 찍음"));
    assert.ok(text.includes("[00:02.00]찍음"));
});

test("the bundled demo song parses and is in order", async () => {
    const { readFile } = await import("node:fs/promises");
    const url = new URL("../songs/demo.lrc", import.meta.url);
    const { meta, lines, synced } = parseLrc(await readFile(url, "utf-8"));
    assert.equal(synced, true);
    assert.equal(meta.title, "야간 주행");
    assert.ok(lines.length > 15);
    for (let i = 1; i < lines.length; i++) {
        assert.ok(lines[i].time >= lines[i - 1].time, `line ${i} out of order`);
    }
});
