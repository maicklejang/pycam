/* 계산 엔진 회귀 테스트:  node --test laser-app/tests/ */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Engine = require("../js/engine.js");
const { MATERIALS, MACHINE_PRESETS, MACHINE_TYPE_INFO } = require("../js/materials.js");
const { PRODUCTS } = require("../js/shop.js");
const TestGrid = require("../js/testgrid.js");

const co2_60 = { type: "co2", watt: 60, maxSpeed: 400 };
const co2_40 = { type: "co2", watt: 40, maxSpeed: 300 };
const diode_10 = { type: "diode", watt: 10, maxSpeed: 250 };
const diode_5 = { type: "diode", watt: 5, maxSpeed: 200 };
const fiber_20 = { type: "fiber", watt: 20, maxSpeed: 3000 };

test("60W CO2 / 3mm 자작합판은 현실적인 범위(10~30mm/s, 1패스)에 든다", () => {
  const r = Engine.calculate({ material: "ply-birch", thickness: 3, machine: co2_60 });
  assert.equal(r.ok, true);
  assert.equal(r.passes, 1);
  assert.ok(r.speedMmS >= 10 && r.speedMmS <= 30, `속도 ${r.speedMmS}`);
  assert.ok(r.powerPct <= MACHINE_TYPE_INFO.co2.powerCapPct);
});

test("출력이 낮은 장비일수록 느리거나 패스가 늘어난다", () => {
  const big = Engine.calculate({ material: "ply-birch", thickness: 3, machine: co2_60 });
  const small = Engine.calculate({ material: "ply-birch", thickness: 3, machine: co2_40 });
  const effBig = big.speedMmS * big.passes ? big.speedMmS / big.passes : 0;
  const effSmall = small.speedMmS / small.passes;
  assert.ok(effSmall < effBig, "40W 가 60W 보다 빠를 수는 없다");
});

test("두께가 늘면 속도가 느려지거나 패스가 늘어난다", () => {
  let prev = Infinity;
  for (const t of [3, 5, 9, 12]) {
    const r = Engine.calculate({ material: "ply-birch", thickness: t, machine: co2_60 });
    if (!r.ok) break;
    const eff = r.speedMmS / r.passes;
    assert.ok(eff <= prev + 1e-9, `${t}mm 에서 실효속도가 되레 빨라짐`);
    prev = eff;
  }
});

test("다이오드로 투명 아크릴은 절단 불가로 안내된다", () => {
  const r = Engine.calculate({ material: "acrylic-cast", thickness: 3, machine: diode_10 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /절단할 수 없습니다/);
  assert.ok(r.alternatives.length > 0, "대체 소재를 제안해야 한다");
});

test("검정 아크릴은 다이오드로 절단 가능", () => {
  const r = Engine.calculate({ material: "acrylic-dark", thickness: 3, machine: diode_10 });
  assert.equal(r.ok, true);
  assert.ok(r.passes >= 1);
});

test("5W 다이오드로 12mm 합판은 불가능하다고 알려준다", () => {
  const r = Engine.calculate({ material: "ply-birch", thickness: 12, machine: diode_5 });
  assert.equal(r.ok, false);
  assert.ok(r.reason.length > 0);
});

test("패스 한도를 넘으면 경고와 함께 절단 한계 두께를 알려준다", () => {
  const r = Engine.calculate({ material: "ply-birch", thickness: 5.5, machine: diode_5 });
  if (r.ok && r.level === "hard") {
    assert.match(r.warnings.join(" "), /한계|부족/);
  }
  const maxT = Engine.maxCuttableThickness(Engine.getMaterial("ply-birch"), diode_5);
  assert.ok(maxT > 0 && maxT < 20);
});

test("조각 계산은 DPI 를 반영하고 소요 시간을 알려준다", () => {
  const a = Engine.calculate({ material: "ply-birch", op: "engrave", machine: co2_60, dpi: 150 });
  const b = Engine.calculate({ material: "ply-birch", op: "engrave", machine: co2_60, dpi: 500 });
  assert.ok(a.ok && b.ok);
  assert.ok(b.secPer100mm2 > a.secPer100mm2, "DPI 가 높을수록 오래 걸려야 한다");
});

test("장비 최고 속도를 넘지 않는다", () => {
  for (const m of [co2_60, diode_10]) {
    for (const mat of MATERIALS) {
      for (const t of mat.thicknesses.length ? mat.thicknesses : [3]) {
        const r = Engine.calculate({ material: mat.id, thickness: t, machine: m });
        if (r.ok) assert.ok(r.speedMmS <= m.maxSpeed + 0.5, `${mat.id} ${t}mm 속도초과 ${r.speedMmS}`);
      }
      const e = Engine.calculate({ material: mat.id, op: "engrave", machine: m });
      if (e.ok) assert.ok(e.speedMmS <= m.maxSpeed + 0.5, `${mat.id} 조각 속도초과`);
    }
  }
});

test("출력 % 는 항상 장비 허용 범위 안에 있다", () => {
  for (const p of MACHINE_PRESETS) {
    const m = { type: p.type, watt: p.watt, maxSpeed: p.maxSpeed };
    const info = MACHINE_TYPE_INFO[p.type];
    for (const mat of MATERIALS) {
      for (const op of ["cut", "engrave"]) {
        const r = Engine.calculate({ material: mat.id, op, thickness: mat.thicknesses[0] || 3, machine: m });
        if (!r.ok) continue;
        assert.ok(r.powerPct >= info.minPowerPct - 0.5 && r.powerPct <= info.powerCapPct + 0.5,
          `${mat.id}/${op}/${p.id} 출력 ${r.powerPct}%`);
        assert.ok(r.passes >= 1 && r.passes <= info.maxPasses);
      }
    }
  }
});

test("파이버 장비는 금속 프리셋(주파수·해치)을 돌려준다", () => {
  const r = Engine.calculate({ material: "stainless", op: "engrave", machine: fiber_20 });
  assert.equal(r.ok, true);
  assert.ok(r.freqKhz > 0 && r.hatchMm > 0);
  const wood = Engine.calculate({ material: "ply-birch", op: "engrave", machine: fiber_20 });
  assert.equal(wood.ok, false, "파이버로 목재 조각은 안내되지 않아야 한다");
});

test("조각 전용 소재는 절단을 거부한다", () => {
  const r = Engine.calculate({ material: "slate", thickness: 5, machine: co2_60 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /조각/);
});

test("소재 데이터 무결성", () => {
  const ids = new Set();
  for (const m of MATERIALS) {
    assert.ok(!ids.has(m.id), "중복 id: " + m.id);
    ids.add(m.id);
    assert.ok(m.name && m.desc && m.category);
    assert.ok(m.factor && m.engraveFactor, m.id);
    if (m.cut) {
      assert.ok(m.cut.k > 0 && m.cut.exp > 0 && m.cut.kerf > 0, m.id);
      assert.ok(m.thicknesses.length > 0, m.id + " 두께 목록 필요");
    }
  }
});

test("상품의 소재 연결과 변형 id 가 유효하다", () => {
  const matIds = new Set(MATERIALS.map((m) => m.id));
  const seen = new Set();
  for (const p of PRODUCTS) {
    if (p.materialId) assert.ok(matIds.has(p.materialId), "없는 소재: " + p.materialId);
    assert.ok(p.variants.length > 0);
    for (const v of p.variants) {
      assert.ok(!seen.has(v.id), "중복 변형 id: " + v.id);
      seen.add(v.id);
      assert.ok(v.price > 0 && v.label);
    }
  }
});

test("테스트 그리드 G코드가 GRBL 문법을 지킨다", () => {
  const g = TestGrid.build({ powerSteps: 3, speedSteps: 4, cell: 8, gap: 2, fill: false });
  assert.match(g.gcode, /^; =+/m);
  assert.ok(g.gcode.includes("G21 G90 G94"));
  assert.ok(g.gcode.trim().endsWith("; 끝"));
  assert.ok(g.gcode.includes("M5"));
  assert.equal(g.powers.length, 3);
  assert.equal(g.speeds.length, 4);
  assert.equal(g.width, 4 * 10 - 2);
  for (const line of g.gcode.split("\n")) {
    if (line.startsWith("G1")) assert.match(line, /F\d+(\.\d+)? S\d+/);
  }
});
