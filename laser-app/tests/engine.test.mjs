/* 계산 엔진 회귀 테스트:  node --test laser-app/tests/engine.test.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Engine = require("../js/engine.js");
const { MATERIALS, MACHINE_PRESETS, MACHINE_TYPE_INFO } = require("../js/materials.js");
const { PRODUCTS } = require("../js/shop.js");
const TestGrid = require("../js/testgrid.js");

const co2_40 = { type: "co2", watt: 40, maxSpeed: 300 };
const co2_60 = { type: "co2", watt: 60, maxSpeed: 400 };
const co2_100 = { type: "co2", watt: 100, maxSpeed: 600 };
const fiber_20 = { type: "fiber", watt: 20, maxSpeed: 3000 };
const fiber_50 = { type: "fiber", watt: 50, maxSpeed: 5000 };

test("장비 목록은 CO2 와 파이버 마킹기만 포함한다", () => {
  assert.deepEqual(Object.keys(MACHINE_TYPE_INFO).sort(), ["co2", "fiber"]);
  for (const p of MACHINE_PRESETS) assert.ok(p.type === "co2" || p.type === "fiber", p.id);
});

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
  assert.ok(small.speedMmS / small.passes < big.speedMmS / big.passes, "40W 가 60W 보다 빠를 수 없다");
});

test("두께가 늘면 실효 속도가 느려진다", () => {
  let prev = Infinity;
  for (const t of [3, 5, 9, 12]) {
    const r = Engine.calculate({ material: "ply-birch", thickness: t, machine: co2_60 });
    if (!r.ok) break;
    const eff = r.speedMmS / r.passes;
    assert.ok(eff <= prev + 1e-9, `${t}mm 에서 실효속도가 되레 빨라짐`);
    prev = eff;
  }
});

test("유효 출력이 모자라면 절단 불가로 안내하고 필요한 장비 출력을 알려준다", () => {
  const r = Engine.calculate({ material: "ply-birch", thickness: 12, machine: co2_40 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /유효 출력/);
  assert.match(r.reason, /W 급 이상/);
  assert.ok(r.maxThickness > 0);
  /* 같은 두께라도 100W 면 잘린다 */
  assert.equal(Engine.calculate({ material: "ply-birch", thickness: 12, machine: co2_100 }).ok, true);
});

test("장비별 절단 한계 두께가 경험칙과 맞는다 (40W≈8mm, 60W≈12mm, 100W≈20mm)", () => {
  const birch = Engine.getMaterial("ply-birch");
  assert.ok(Math.abs(Engine.maxCuttableThickness(birch, co2_40) - 8) < 1.5);
  assert.ok(Math.abs(Engine.maxCuttableThickness(birch, co2_60) - 12) < 1.5);
  assert.ok(Math.abs(Engine.maxCuttableThickness(birch, co2_100) - 20) < 1.5);
});

test("절단 한계 이하 두께는 모두 절단 가능으로 나온다", () => {
  for (const mat of MATERIALS.filter((m) => m.cut)) {
    for (const m of [co2_40, co2_60, co2_100]) {
      const limit = Engine.maxCuttableThickness(mat, m);
      for (const t of mat.thicknesses.filter((x) => x <= limit - 0.01)) {
        assert.equal(Engine.calculate({ material: mat.id, thickness: t, machine: m }).ok, true,
          `${mat.id} ${t}mm / ${m.watt}W`);
      }
    }
  }
});

test("파이버 마킹기로는 목재·아크릴을 자를 수 없고, 추천도 마킹 가능한 소재만 준다", () => {
  const fiberIds = new Set(MATERIALS.filter((m) => m.fiber).map((m) => m.id));
  for (const id of ["ply-birch", "acrylic-cast", "leather-veg"]) {
    const r = Engine.calculate({ material: id, thickness: 3, machine: fiber_20 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /CO2 장비가 필요합니다/);
    assert.ok(r.alternatives.length > 0, "대체 소재를 제안해야 한다");
    for (const a of r.alternatives) {
      assert.ok(fiberIds.has(a.id), `파이버로 불가능한 ${a.id} 를 추천하면 안 된다`);
    }
  }
});

test("대체 소재 추천은 언제나 현재 장비로 가능한 것만 나온다", () => {
  for (const p of MACHINE_PRESETS) {
    const m = { type: p.type, watt: p.watt, maxSpeed: p.maxSpeed };
    for (const mat of MATERIALS) {
      for (const op of ["cut", "engrave"]) {
        const r = Engine.calculate({ material: mat.id, op, thickness: mat.thicknesses[0] || 3, machine: m });
        for (const a of r.alternatives || []) {
          const alt = Engine.getMaterial(a.id);
          /* 대체 소재는 같은 가공이든(절단→절단), 이 장비가 할 수 있는 다른 가공이든 반드시 가능해야 한다 */
          const sameOp = Engine.calculate({ material: alt.id, op, thickness: alt.thicknesses[0] || 3, machine: m }).ok;
          const engraveOp = Engine.calculate({ material: alt.id, op: "engrave", machine: m }).ok;
          assert.ok(sameOp || engraveOp, `${p.id}/${op}: ${mat.id} 의 대체로 불가능한 ${alt.id} 추천`);
        }
      }
    }
  }
});

test("파이버 마킹기는 금속 프리셋(주파수·해치)을 돌려주고 출력에 따라 빨라진다", () => {
  const a = Engine.calculate({ material: "stainless", op: "engrave", machine: fiber_20 });
  const b = Engine.calculate({ material: "stainless", op: "engrave", machine: fiber_50 });
  assert.equal(a.ok, true);
  assert.ok(a.freqKhz > 0 && a.hatchMm > 0 && a.passes >= 1);
  assert.ok(b.speedMmS > a.speedMmS, "50W 가 20W 보다 빨라야 한다");
  const wood = Engine.calculate({ material: "ply-birch", op: "engrave", machine: fiber_20 });
  assert.equal(wood.ok, false, "파이버로 목재 조각은 안내되지 않아야 한다");
  assert.match(wood.reason, /파이버 마킹기 대상 소재가 아닙니다/);
});

test("금속 소재는 파이버 프리셋을 갖추고 있다", () => {
  for (const m of MATERIALS.filter((x) => x.category === "metal")) {
    assert.ok(m.fiber, m.id + " 에 파이버 프리셋이 없다");
    assert.ok(m.fiber.speed > 0 && m.fiber.powerPct > 0 && m.fiber.freqKhz > 0 && m.fiber.hatchMm > 0, m.id);
    assert.equal(m.cut, null, m.id + " 은 절단 대상이 아니어야 한다");
  }
});

test("CO2 로 마킹되는 금속(아노다이징·도장)은 CO2 조각값도 준다", () => {
  for (const id of ["anodized-alu", "coated-metal"]) {
    const r = Engine.calculate({ material: id, op: "engrave", machine: co2_60 });
    assert.equal(r.ok, true, id);
  }
  const bare = Engine.calculate({ material: "stainless", op: "engrave", machine: co2_60 });
  assert.equal(bare.ok, false, "생 스테인리스는 CO2 로 마킹되지 않는다");
});

test("조각 계산은 DPI 를 반영하고 소요 시간을 알려준다", () => {
  const a = Engine.calculate({ material: "ply-birch", op: "engrave", machine: co2_60, dpi: 150 });
  const b = Engine.calculate({ material: "ply-birch", op: "engrave", machine: co2_60, dpi: 500 });
  assert.ok(a.ok && b.ok);
  assert.ok(b.secPer100mm2 > a.secPer100mm2, "DPI 가 높을수록 오래 걸려야 한다");
});

test("장비 최고 속도와 출력 범위를 벗어나지 않는다", () => {
  for (const p of MACHINE_PRESETS) {
    const m = { type: p.type, watt: p.watt, maxSpeed: p.maxSpeed };
    const info = MACHINE_TYPE_INFO[p.type];
    for (const mat of MATERIALS) {
      for (const t of (mat.thicknesses.length ? mat.thicknesses : [3])) {
        const r = Engine.calculate({ material: mat.id, thickness: t, machine: m });
        if (!r.ok) continue;
        assert.ok(r.speedMmS <= m.maxSpeed + 0.5, `${mat.id} ${t}mm 속도초과 ${r.speedMmS}`);
        assert.ok(r.powerPct >= info.minPowerPct - 0.5 && r.powerPct <= info.powerCapPct + 0.5, `${mat.id} 출력 ${r.powerPct}%`);
        assert.ok(r.passes >= 1 && r.passes <= info.maxPasses);
      }
      const e = Engine.calculate({ material: mat.id, op: "engrave", machine: m });
      if (e.ok) assert.ok(e.speedMmS <= m.maxSpeed + 0.5, `${mat.id} 조각 속도초과`);
    }
  }
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
    assert.deepEqual(Object.keys(m.factor).sort(), ["co2", "fiber"], m.id);
    assert.deepEqual(Object.keys(m.engraveFactor).sort(), ["co2", "fiber"], m.id);
    if (m.cut) {
      assert.ok(m.cut.k > 0 && m.cut.exp > 0 && m.cut.kerf > 0 && m.cut.wPerMm > 0, m.id);
      assert.ok(m.thicknesses.length > 0, m.id + " 두께 목록 필요");
      assert.ok(m.cut.maxThickness.co2 > 0, m.id);
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
