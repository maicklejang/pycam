/*
 * 레이저 설정 계산 엔진
 *
 * 물리 모델
 *   유효 출력      P[W]      = 장비출력 x 파워%
 *   절단 선에너지  E[J/mm]   = k x 두께^exp x 장비계수
 *   절단 속도      v[mm/s]   = 패스수 x P / E
 *   조각 면에너지  D[J/mm2]  = density x 장비계수
 *   조각 속도      v[mm/s]   = P / (D x 라인간격)      (라인간격 = 25.4 / DPI)
 *
 * 계산 결과는 '시작값'이며, 실제 값은 렌즈·초점·에어어시스트·소재 편차에 따라
 * ±30% 정도 달라질 수 있습니다. 반드시 테스트 그리드로 검증하세요.
 */
const LaserEngine = (function (deps) {
  const TYPE = deps.MACHINE_TYPE_INFO;
  const MATS = deps.MATERIALS;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function roundSpeed(v) {
    if (v >= 100) return Math.round(v);
    if (v >= 10) return Math.round(v * 2) / 2;
    return Math.round(v * 10) / 10;
  }
  function toMmMin(v) {
    const m = v * 60;
    return m >= 100 ? Math.round(m / 10) * 10 : Math.round(m / 5) * 5;
  }
  function getMaterial(id) {
    return MATS.find((m) => m.id === id) || null;
  }
  function machineInfo(machine) {
    return TYPE[machine.type];
  }

  /* 이 장비로 절단 가능한 최대 두께 (패스 한도 기준) */
  function maxCuttableThickness(mat, machine) {
    if (!mat.cut) return 0;
    const f = mat.factor[machine.type];
    if (!f) return 0;
    const info = machineInfo(machine);
    const pct = Math.min(mat.cut.powerPct[machine.type] || 100, info.powerCapPct);
    const P = (machine.watt * pct) / 100;
    const Emax = (info.maxPasses * P) / info.minSpeed;
    const t = Math.pow(Emax / (mat.cut.k * f), 1 / mat.cut.exp);
    return Math.min(t, mat.cut.maxThickness[machine.type] || 0);
  }

  function calcCut(mat, thickness, machine, opts) {
    opts = opts || {};
    const info = machineInfo(machine);
    const res = {
      op: opts.op || "cut", ok: false, level: "impossible",
      material: mat.id, materialName: mat.name, thickness, machine,
      notes: [], warnings: [], alternatives: [],
    };

    if (!mat.cut) {
      res.reason = `${mat.name}은(는) 조각(마킹) 전용 소재입니다. 절단은 할 수 없습니다.`;
      return res;
    }
    const f = mat.factor[machine.type];
    if (!f) {
      res.reason = `${info.label} 장비로는 ${mat.name}을(를) 절단할 수 없습니다.`;
      res.alternatives = suggestAlternatives(mat, "cut");
      return res;
    }
    const hardMax = mat.cut.maxThickness[machine.type] || 0;
    if (thickness > hardMax) {
      res.reason = `${mat.name}은(는) ${info.label} 방식에서 약 ${hardMax}mm까지만 절단면이 유지됩니다.`;
      return res;
    }

    const E = mat.cut.k * Math.pow(thickness, mat.cut.exp) * f;
    let powerPct = Math.min(mat.cut.powerPct[machine.type] || 100, info.powerCapPct);
    let P = (machine.watt * powerPct) / 100;
    let passes = 1;
    let v = P / E;

    /* 너무 빠르면 출력을 낮춘다 */
    if (v > machine.maxSpeed) {
      const target = machine.maxSpeed * 0.8;
      powerPct = clamp((powerPct * target) / v, info.minPowerPct, info.powerCapPct);
      P = (machine.watt * powerPct) / 100;
      v = P / E;
      if (v > machine.maxSpeed) {
        v = machine.maxSpeed;
        res.notes.push("장비 최고 속도에 도달했습니다. 여러 장을 겹쳐 자르거나 가속도(acceleration) 설정을 확인하세요.");
      }
    }

    /* 너무 느리면 패스를 나눈다 */
    let capped = false;
    if (v < info.minSpeed) {
      passes = Math.ceil((info.minSpeed * E) / P);
      if (passes > info.maxPasses) { passes = info.maxPasses; capped = true; }
      v = (passes * P) / E;
    }

    res.ok = true;
    res.level = capped ? "hard" : passes >= info.maxPasses * 0.7 ? "slow" : "ok";
    res.powerPct = Math.round(powerPct);
    res.speedMmS = roundSpeed(v);
    res.speedMmMin = toMmMin(v);
    res.passes = passes;
    res.lineEnergy = Math.round(E * 100) / 100;
    res.kerf = mat.cut.kerf;
    res.airAssist = true;
    res.secPerMeter = Math.round((1000 / v) * passes);
    res.focus = machine.type === "diode" ? "소재 표면" : thickness >= 6 ? "표면에서 두께의 1/3 아래" : "소재 표면";

    if (capped) {
      const maxT = maxCuttableThickness(mat, machine);
      res.warnings.push(
        `출력이 부족합니다. ${machine.watt}W ${info.label} 장비의 현실적인 ${mat.name} 절단 한계는 약 ${Math.round(maxT * 10) / 10}mm입니다. 패스를 더 늘리면 절단면이 심하게 타고 폭이 벌어집니다.`
      );
      res.alternatives = suggestAlternatives(mat, "cut");
    }
    if (res.level === "slow") {
      res.notes.push("패스가 많습니다. 한 패스마다 초점을 다시 맞출 필요는 없지만, 소재가 움직이지 않게 고정하세요.");
    }
    if (machine.type === "co2" && res.powerPct <= info.minPowerPct + 1) {
      res.warnings.push("CO2 튜브는 10% 부근에서 방전이 불안정합니다. 출력을 유지한 채 속도를 더 올리세요.");
    }
    return res;
  }

  function calcScore(mat, machine) {
    const r = calcCut(mat, 0.3, machine, { op: "score" });
    if (r.ok) {
      r.passes = 1;
      r.speedMmS = roundSpeed(Math.min(r.speedMmS * 1.5, machine.maxSpeed));
      r.speedMmMin = toMmMin(r.speedMmS);
      r.notes.unshift("외곽선(벡터) 조각 값입니다. 관통되지 않을 만큼만 태우는 설정이므로 자투리로 농도를 먼저 확인하세요.");
    }
    return r;
  }

  function calcEngrave(mat, machine, dpiOverride) {
    const info = machineInfo(machine);
    const res = {
      op: "engrave", ok: false, level: "impossible",
      material: mat.id, materialName: mat.name, machine,
      notes: [], warnings: [], alternatives: [],
    };
    if (!mat.engrave) {
      res.reason = `${mat.name}의 조각 데이터가 없습니다.`;
      return res;
    }

    /* 파이버 장비는 주파수·해치가 포함된 프리셋을 사용 */
    if (machine.type === "fiber") {
      if (!mat.fiber) {
        res.reason = `${mat.name}은(는) 파이버 레이저 대상 소재가 아닙니다. CO2 또는 다이오드 장비를 사용하세요.`;
        return res;
      }
      const scale = clamp(machine.watt / 20, 0.5, 3);
      const v = Math.min(mat.fiber.speed * scale, machine.maxSpeed);
      res.ok = true;
      res.level = "ok";
      res.powerPct = mat.fiber.powerPct;
      res.speedMmS = Math.round(v);
      res.speedMmMin = toMmMin(v);
      res.passes = mat.fiber.passes;
      res.freqKhz = mat.fiber.freqKhz;
      res.hatchMm = mat.fiber.hatchMm;
      res.dpi = Math.round(25.4 / mat.fiber.hatchMm);
      res.notes.push(`해치 간격 ${mat.fiber.hatchMm}mm, 주파수 ${mat.fiber.freqKhz}kHz 기준입니다. 색 마킹(MOPA)은 주파수를 크게 바꿔가며 시험하세요.`);
      return res;
    }

    const ef = mat.engraveFactor[machine.type];
    if (!ef) {
      res.reason = `${info.label} 장비로는 ${mat.name}에 조각할 수 없습니다.`;
      res.alternatives = suggestAlternatives(mat, "engrave");
      return res;
    }

    const dpi = dpiOverride || mat.engrave.dpi;
    const spacing = 25.4 / dpi;
    const D = mat.engrave.density * ef;
    let powerPct = clamp(mat.engrave.powerPct[machine.type] || 30, info.minPowerPct, info.powerCapPct);
    let P = (machine.watt * powerPct) / 100;
    let v = P / (D * spacing);

    if (v > machine.maxSpeed) {
      const target = machine.maxSpeed * 0.85;
      const wanted = clamp((powerPct * target) / v, info.minPowerPct, info.powerCapPct);
      if (wanted <= info.minPowerPct + 0.01) {
        powerPct = info.minPowerPct;
        v = machine.maxSpeed;
        res.notes.push(`출력을 더 낮출 수 없어 최고 속도로 계산했습니다. 농도가 너무 진하면 DPI를 ${Math.round(dpi / 2)}으로 낮추세요.`);
      } else {
        powerPct = wanted;
        v = machine.maxSpeed * 0.85;
      }
      P = (machine.watt * powerPct) / 100;
    }

    res.ok = true;
    res.dpi = dpi;
    res.spacing = Math.round(spacing * 1000) / 1000;
    res.powerPct = Math.round(powerPct);
    res.speedMmS = roundSpeed(v);
    res.speedMmMin = toMmMin(v);
    res.passes = 1;
    res.areaEnergy = Math.round(D * 100) / 100;
    /* 100 x 100 mm 면적 소요 시간 (왕복 오버스캔 15% 가산) */
    res.secPer100mm2 = Math.round(((100 / spacing) * 100 / v) * 1.15);
    res.level = v < 8 ? "slow" : "ok";
    if (res.level === "slow") {
      res.warnings.push("너무 느립니다. DPI를 낮추거나 출력을 높이지 않으면 100x100mm 한 장에 매우 오래 걸립니다.");
    }
    if (machine.type === "diode" && mat.category === "wood") {
      res.notes.push("다이오드는 목재 조각에 유리합니다. 농도가 옅으면 출력보다 속도를 먼저 낮추세요.");
    }
    return res;
  }

  function suggestAlternatives(mat, op) {
    return MATS.filter((m) => m.id !== mat.id && m.category === mat.category)
      .filter((m) => (op === "cut" ? m.cut : m.engrave))
      .slice(0, 3)
      .map((m) => ({ id: m.id, name: m.name }));
  }

  function calculate(o) {
    const mat = typeof o.material === "string" ? getMaterial(o.material) : o.material;
    if (!mat) throw new Error("알 수 없는 소재: " + o.material);
    const machine = o.machine;
    if (!machine || !TYPE[machine.type]) throw new Error("장비 정보가 없습니다.");
    if (o.op === "engrave") return calcEngrave(mat, machine, o.dpi);
    if (o.op === "score") return calcScore(mat, machine);
    return calcCut(mat, o.thickness, machine);
  }

  /* 두께별 요약표 */
  function thicknessTable(mat, machine) {
    if (!mat.cut || !mat.thicknesses.length) return [];
    return mat.thicknesses.map((t) => {
      const r = calcCut(mat, t, machine);
      return {
        thickness: t, ok: r.ok, level: r.level, reason: r.reason,
        powerPct: r.powerPct, speedMmS: r.speedMmS, speedMmMin: r.speedMmMin, passes: r.passes,
      };
    });
  }

  return { calculate, calcCut, calcEngrave, calcScore, thicknessTable, maxCuttableThickness, getMaterial };
})(typeof module !== "undefined" ? require("./materials.js") : { MATERIALS, MACHINE_TYPE_INFO });

if (typeof module !== "undefined") module.exports = LaserEngine;
