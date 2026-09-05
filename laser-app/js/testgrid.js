/*
 * 파워 x 속도 테스트 그리드 G코드 생성기 (GRBL 1.1 / LightBurn·LaserGRBL 호환)
 *
 * 가로축 = 속도, 세로축 = 출력. 실제 소재로 한 번 돌려보고
 * 가장 좋은 칸의 값을 그대로 쓰면 됩니다.
 */
const TestGrid = (function () {
  function range(from, to, count) {
    if (count < 2) return [from];
    const step = (to - from) / (count - 1);
    return Array.from({ length: count }, (_, i) => Math.round((from + step * i) * 10) / 10);
  }

  function build(o) {
    const opt = Object.assign({
      powerFrom: 20, powerTo: 100, powerSteps: 5,
      speedFrom: 200, speedTo: 3000, speedSteps: 5, // mm/min
      cell: 10, gap: 3, lineGap: 0.15, sMax: 1000,
      mode: "M4", fill: true, passes: 1, originNote: "왼쪽 아래",
    }, o || {});

    const powers = range(opt.powerFrom, opt.powerTo, opt.powerSteps);
    const speeds = range(opt.speedFrom, opt.speedTo, opt.speedSteps);
    const pitch = opt.cell + opt.gap;
    const g = [];

    g.push("; ==============================================");
    g.push("; 레이저 파워 x 속도 테스트 그리드");
    g.push("; 가로(X) = 속도 " + speeds.join(" / ") + " mm/min");
    g.push("; 세로(Y) = 출력 " + powers.join(" / ") + " %  (아래쪽이 낮은 출력)");
    g.push("; 칸 크기 " + opt.cell + "mm, 간격 " + opt.gap + "mm, 원점 = " + opt.originNote);
    g.push("; S값 최대 " + opt.sMax + " / 모드 " + opt.mode + " / 패스 " + opt.passes);
    g.push("; ==============================================");
    g.push("G21 G90 G94");
    g.push(opt.mode + " S0");

    powers.forEach((pw, row) => {
      const S = Math.round((pw / 100) * opt.sMax);
      speeds.forEach((sp, col) => {
        const x0 = col * pitch, y0 = row * pitch;
        g.push(`; --- 출력 ${pw}% / 속도 ${sp}mm/min ---`);
        for (let p = 0; p < opt.passes; p++) {
          if (opt.fill) {
            let y = y0, dir = 1;
            while (y <= y0 + opt.cell + 1e-9) {
              g.push(`G0 X${(dir > 0 ? x0 : x0 + opt.cell).toFixed(2)} Y${y.toFixed(2)}`);
              g.push(`G1 X${(dir > 0 ? x0 + opt.cell : x0).toFixed(2)} Y${y.toFixed(2)} F${sp} S${S}`);
              g.push("S0");
              y += opt.lineGap;
              dir = -dir;
            }
          } else {
            g.push(`G0 X${x0.toFixed(2)} Y${y0.toFixed(2)}`);
            g.push(`G1 X${(x0 + opt.cell).toFixed(2)} Y${y0.toFixed(2)} F${sp} S${S}`);
            g.push(`G1 X${(x0 + opt.cell).toFixed(2)} Y${(y0 + opt.cell).toFixed(2)} F${sp} S${S}`);
            g.push(`G1 X${x0.toFixed(2)} Y${(y0 + opt.cell).toFixed(2)} F${sp} S${S}`);
            g.push(`G1 X${x0.toFixed(2)} Y${y0.toFixed(2)} F${sp} S${S}`);
            g.push("S0");
          }
        }
      });
    });

    g.push("M5");
    g.push("G0 X0 Y0");
    g.push("; 끝");

    return {
      gcode: g.join("\n"),
      powers, speeds,
      width: Math.round(speeds.length * pitch - opt.gap),
      height: Math.round(powers.length * pitch - opt.gap),
      lines: g.length,
    };
  }

  return { build, range };
})();

if (typeof module !== "undefined") module.exports = TestGrid;
