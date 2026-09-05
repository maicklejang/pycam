/* 레이저 소재 가이드 — 화면 로직 */
(function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const won = (n) => Number(n).toLocaleString("ko-KR") + SHOP_CONFIG.currency;

  const state = {
    view: "calc",
    materialId: null,
    op: "cut",
    thickness: null,
    dpi: null,
    cat: "all",
    q: "",
    lastResult: null,
  };

  /* ============================ 공통 UI ============================ */
  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 1900);
  }
  function openSheet(title, html, after) {
    $("#sheetTitle").textContent = title;
    $("#sheetBody").innerHTML = html;
    $("#sheet").hidden = false;
    $("#sheetBackdrop").hidden = false;
    if (after) after($("#sheetBody"));
  }
  function closeSheet() {
    $("#sheet").hidden = true;
    $("#sheetBackdrop").hidden = true;
  }
  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function copy(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => toast("복사했습니다"), () => toast("복사 실패"));
    } else {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast("복사했습니다"); } catch (e) { toast("복사 실패"); }
      ta.remove();
    }
  }
  function machineLabel(m) {
    if (m.label) return m.label;
    return `${MACHINE_TYPE_INFO[m.type].label.split(" ")[0]} ${m.watt}W`;
  }
  function opLabel(op) {
    return op === "cut" ? "절단" : op === "engrave" ? "조각" : "외곽선 조각";
  }

  /* ============================ 뷰 전환 ============================ */
  function setView(v) {
    state.view = v;
    ["calc", "shop", "grid", "log", "safety"].forEach((n) => {
      $("#view-" + n).hidden = n !== v;
    });
    $$("#tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
    window.scrollTo(0, 0);
    ({ calc: renderCalc, shop: renderShop, grid: renderGrid, log: renderLog, safety: renderSafety }[v])();
  }

  /* ============================ 장비 설정 ============================ */
  function machineSheet() {
    const cur = Store.machine();
    const list = MACHINE_PRESETS.map((p) => `
      <button data-preset="${p.id}" class="${p.id === cur.presetId ? "sel" : ""}">
        <b>${esc(p.label)}</b><span class="spacer"></span><span class="small muted">${p.watt}W</span>
      </button>`).join("");
    openSheet("내 장비 설정", `
      <p class="small muted" style="margin-top:0">보유한 장비를 고르면 모든 설정값이 그 출력에 맞춰 다시 계산됩니다.</p>
      <div class="list-choice">${list}</div>
      <div class="section-title">직접 입력</div>
      <div class="grid2">
        <label class="field"><span>레이저 광출력 (W)</span><input type="number" id="mWatt" value="${cur.watt}" min="1" max="500" step="0.5"></label>
        <label class="field"><span>최고 이송속도 (mm/min)</span><input type="number" id="mSpeed" value="${Math.round(cur.maxSpeed * 60)}" min="60" step="60"></label>
      </div>
      <label class="field"><span>레이저 종류</span>
        <select id="mType">
          ${Object.keys(MACHINE_TYPE_INFO).map((k) => `<option value="${k}" ${k === cur.type ? "selected" : ""}>${esc(MACHINE_TYPE_INFO[k].label)}</option>`).join("")}
        </select>
      </label>
      <div class="note" id="typeHint">${esc(MACHINE_TYPE_INFO[cur.type].hint)}</div>
      <div class="btn-row"><button class="btn primary block" id="mSave">저장</button></div>
    `, (body) => {
      $$("button[data-preset]", body).forEach((b) => b.addEventListener("click", () => {
        const p = MACHINE_PRESETS.find((x) => x.id === b.dataset.preset);
        Store.setMachine({ presetId: p.id, label: p.label, type: p.type, watt: p.watt, maxSpeed: p.maxSpeed });
        closeSheet(); syncMachineChip(); setView(state.view); toast(p.label + " 로 설정했습니다");
      }));
      $("#mType", body).addEventListener("change", (e) => {
        $("#typeHint", body).textContent = MACHINE_TYPE_INFO[e.target.value].hint;
      });
      $("#mSave", body).addEventListener("click", () => {
        const type = $("#mType", body).value;
        const watt = Math.max(1, parseFloat($("#mWatt", body).value) || 10);
        const maxSpeed = Math.max(1, (parseFloat($("#mSpeed", body).value) || 6000) / 60);
        Store.setMachine({ presetId: "custom", label: `${MACHINE_TYPE_INFO[type].label.split(" ")[0]} ${watt}W`, type, watt, maxSpeed });
        closeSheet(); syncMachineChip(); setView(state.view); toast("장비 설정을 저장했습니다");
      });
    });
  }
  function syncMachineChip() {
    $("#machineBtn").textContent = machineLabel(Store.machine());
  }

  /* ============================ 설정 계산기 ============================ */
  function renderCalc() {
    const v = $("#view-calc");
    if (!v.dataset.built) {
      v.innerHTML = `
        <div class="card">
          <label class="field" style="margin:0">
            <span>소재 검색</span>
            <input id="calcQ" type="search" placeholder="예: 자작, 아크릴, 가죽" autocomplete="off">
          </label>
        </div>
        <div class="filter-row" id="calcCats"></div>
        <div class="mat-grid" id="matGrid"></div>
        <div id="calcDetail"></div>`;
      v.dataset.built = "1";
      $("#calcQ", v).addEventListener("input", (e) => { state.q = e.target.value.trim(); renderMatGrid(); });
    }
    renderCats();
    renderMatGrid();
    renderDetail();
  }

  function renderCats() {
    const cats = ["all"].concat(Object.keys(CATEGORY_LABELS));
    $("#calcCats").innerHTML = cats.map((c) =>
      `<button class="chip ${state.cat === c ? "on" : ""}" data-cat="${c}">${c === "all" ? "전체" : esc(CATEGORY_LABELS[c])}</button>`).join("");
    $$("#calcCats button").forEach((b) => b.addEventListener("click", () => {
      state.cat = b.dataset.cat; renderCats(); renderMatGrid();
    }));
  }

  function filteredMaterials() {
    const q = state.q.toLowerCase();
    return MATERIALS.filter((m) =>
      (state.cat === "all" || m.category === state.cat) &&
      (!q || m.name.toLowerCase().includes(q) || m.desc.toLowerCase().includes(q) || m.id.includes(q)));
  }

  function renderMatGrid() {
    const list = filteredMaterials();
    const g = $("#matGrid");
    if (!list.length) { g.innerHTML = `<p class="muted small">검색 결과가 없습니다.</p>`; return; }
    g.innerHTML = list.map((m) => `
      <button class="mat-card ${m.id === state.materialId ? "sel" : ""}" data-mat="${m.id}">
        <span class="swatch sw-${m.category}"></span>
        <b>${esc(m.name)}</b>
        <span class="cat">${esc(CATEGORY_LABELS[m.category])}${m.cut ? "" : " · 조각 전용"}</span>
      </button>`).join("");
    $$("button[data-mat]", g).forEach((b) => b.addEventListener("click", () => {
      selectMaterial(b.dataset.mat);
    }));
  }

  function selectMaterial(id) {
    const mat = LaserEngine.getMaterial(id);
    state.materialId = id;
    state.op = mat.cut ? "cut" : "engrave";
    state.thickness = mat.thicknesses.length ? mat.thicknesses[Math.min(1, mat.thicknesses.length - 1)] : null;
    state.dpi = null;
    renderMatGrid();
    renderDetail();
    const d = $("#calcDetail");
    if (d) d.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderDetail() {
    const box = $("#calcDetail");
    if (!state.materialId) {
      box.innerHTML = `<div class="card" style="margin-top:12px">
        <b>소재를 고르세요</b>
        <p class="small muted" style="margin:6px 0 0">
          내 장비(<b>${esc(machineLabel(Store.machine()))}</b>) 출력에 맞춰 절단·조각의 출력%, 속도, 패스 수를 계산해 드립니다.
          장비가 다르면 오른쪽 위 버튼에서 바꾸세요.</p>
        <div class="note">${esc(SHOP_CONFIG.notice)}</div></div>`;
      return;
    }
    const mat = LaserEngine.getMaterial(state.materialId);
    const machine = Store.machine();
    const ops = [];
    if (mat.cut) ops.push("cut", "score");
    if (mat.engrave) ops.push("engrave");
    if (!ops.includes(state.op)) state.op = ops[0];

    const thickChips = mat.cut && state.op !== "engrave" ? `
      <div class="section-title">두께</div>
      <div class="filter-row">
        ${mat.thicknesses.map((t) => `<button class="chip ${t === state.thickness ? "on" : ""}" data-th="${t}">${t}mm</button>`).join("")}
        <button class="chip" data-th="custom">직접입력</button>
      </div>` : "";

    const dpiSel = state.op === "engrave" && machine.type !== "fiber" ? `
      <div class="section-title">해상도 (DPI)</div>
      <div class="filter-row">
        ${[150, 200, 254, 300, 400, 500].map((d) => {
          const cur = state.dpi || mat.engrave.dpi;
          return `<button class="chip ${d === cur ? "on" : ""}" data-dpi="${d}">${d}</button>`;
        }).join("")}
      </div>` : "";

    box.innerHTML = `
      <div class="card" style="margin-top:14px">
        <div class="row wrap">
          <h3 style="flex:1">${esc(mat.name)}</h3>
          <span class="pill">${esc(CATEGORY_LABELS[mat.category])}</span>
        </div>
        <p class="small muted" style="margin:6px 0 0">${esc(mat.desc)}</p>
        <div class="section-title">가공 종류</div>
        <div class="filter-row">
          ${ops.map((o) => `<button class="chip ${o === state.op ? "on" : ""}" data-op="${o}">${opLabel(o)}</button>`).join("")}
        </div>
        ${thickChips}${dpiSel}
      </div>
      <div id="resultBox"></div>`;

    $$("button[data-op]", box).forEach((b) => b.addEventListener("click", () => { state.op = b.dataset.op; renderDetail(); }));
    $$("button[data-th]", box).forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.th === "custom") {
        const v = prompt("두께를 mm 단위로 입력하세요", String(state.thickness || 3));
        const n = parseFloat(v);
        if (!isNaN(n) && n > 0) state.thickness = n;
      } else state.thickness = parseFloat(b.dataset.th);
      renderDetail();
    }));
    $$("button[data-dpi]", box).forEach((b) => b.addEventListener("click", () => { state.dpi = parseInt(b.dataset.dpi, 10); renderDetail(); }));

    renderResult(mat, machine);
  }

  function renderResult(mat, machine) {
    const box = $("#resultBox");
    let r;
    try {
      r = LaserEngine.calculate({
        material: mat.id, op: state.op,
        thickness: state.thickness || (mat.thicknesses[0] || 3),
        machine, dpi: state.dpi,
      });
    } catch (e) {
      box.innerHTML = `<div class="card danger">${esc(e.message)}</div>`;
      return;
    }
    state.lastResult = r;

    if (!r.ok) {
      const alts = (r.alternatives || []).map((a) => `<button class="chip" data-alt="${a.id}">${esc(a.name)}</button>`).join("");
      box.innerHTML = `
        <div class="card result bad">
          <h3>이 조합은 불가능합니다</h3>
          <div class="danger">${esc(r.reason)}</div>
          ${alts ? `<div class="section-title">대신 이런 소재는 어떠세요?</div><div class="filter-row">${alts}</div>` : ""}
          <div class="btn-row"><button class="btn block" id="toShop">재료 보러 가기</button></div>
        </div>`;
      $$("button[data-alt]", box).forEach((b) => b.addEventListener("click", () => selectMaterial(b.dataset.alt)));
      $("#toShop", box).addEventListener("click", () => setView("shop"));
      return;
    }

    const isEngrave = r.op === "engrave";
    const meta = isEngrave ? [
      ["속도(mm/s)", r.speedMmS + " mm/s"],
      ["라인 간격", (r.spacing || r.hatchMm) + " mm"],
      ["해상도", (r.dpi || "-") + " DPI"],
      ["100x100mm 소요", fmtSec(r.secPer100mm2)],
      r.freqKhz ? ["주파수", r.freqKhz + " kHz"] : ["면에너지", (r.areaEnergy || "-") + " J/mm²"],
      ["에어어시스트", machine.type === "fiber" ? "불필요" : "약하게"],
    ] : [
      ["속도(mm/s)", r.speedMmS + " mm/s"],
      ["필요 선에너지", r.lineEnergy + " J/mm"],
      ["초점", r.focus],
      ["에어어시스트", "켜기(권장)"],
      ["커프(절단폭)", r.kerf + " mm"],
      ["1m 절단 소요", fmtSec(r.secPerMeter)],
    ];

    const levelPill = r.level === "ok" ? `<span class="pill ok">여유 있음</span>`
      : r.level === "slow" ? `<span class="pill warn">가능하지만 느림</span>`
      : `<span class="pill bad">출력 한계</span>`;

    const table = !isEngrave && mat.cut ? renderThicknessTable(mat, machine) : "";
    const product = PRODUCTS.find((p) => p.materialId === mat.id);

    box.innerHTML = `
      <div class="card result">
        <div class="row wrap">
          <h3 style="flex:1">${esc(mat.name)} · ${opLabel(r.op)}${r.thickness ? " " + r.thickness + "mm" : ""}</h3>
          ${levelPill}
        </div>
        <div class="small muted">${esc(machineLabel(machine))} 기준 시작값</div>
        <div class="big-grid">
          <div class="big"><div class="v">${r.powerPct}<small>%</small></div><div class="k">출력</div></div>
          <div class="big"><div class="v">${r.speedMmMin}</div><div class="k">속도 mm/min</div></div>
          <div class="big"><div class="v">${r.passes}<small>회</small></div><div class="k">패스</div></div>
        </div>
        <div class="meta">${meta.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}</div>
        ${(r.warnings || []).map((w) => `<div class="warn">${esc(w)}</div>`).join("")}
        ${(mat.warns || []).map((w) => `<div class="warn">${esc(w)}</div>`).join("")}
        ${(r.notes || []).concat(mat.tips || []).map((n) => `<div class="note">${esc(n)}</div>`).join("")}
        <div class="btn-row">
          <button class="btn" id="saveLog">기록 저장</button>
          <button class="btn" id="mkGrid">테스트 그리드</button>
        </div>
        ${product ? `<div class="btn-row"><button class="btn primary block" id="buyMat">${esc(mat.name)} 구매하기</button></div>` : ""}
      </div>
      ${table}`;

    $("#saveLog", box).addEventListener("click", () => saveLogSheet(r, mat, machine));
    $("#mkGrid", box).addEventListener("click", () => { setView("grid"); });
    if (product) $("#buyMat", box).addEventListener("click", () => { setView("shop"); setTimeout(() => productSheet(product.id), 60); });
  }

  function fmtSec(s) {
    if (s == null) return "-";
    if (s < 60) return s + "초";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "분 " + (s % 60) + "초";
    return Math.floor(m / 60) + "시간 " + (m % 60) + "분";
  }

  function renderThicknessTable(mat, machine) {
    const rows = LaserEngine.thicknessTable(mat, machine);
    if (!rows.length) return "";
    const maxT = LaserEngine.maxCuttableThickness(mat, machine);
    return `<div class="card">
      <div class="section-title" style="margin-top:0">두께별 요약 · ${esc(machineLabel(machine))}</div>
      <table>
        <tr><th>두께</th><th>출력</th><th>속도(mm/min)</th><th>패스</th></tr>
        ${rows.map((r) => r.ok
          ? `<tr><td>${r.thickness}mm</td><td>${r.powerPct}%</td><td>${r.speedMmMin}</td><td>${r.passes}${r.level === "hard" ? " ⚠" : ""}</td></tr>`
          : `<tr><td>${r.thickness}mm</td><td colspan="3" class="x">이 장비로는 어려움</td></tr>`).join("")}
      </table>
      <p class="small muted" style="margin-bottom:0">이 장비의 현실적인 절단 한계는 약 <b>${Math.round(maxT * 10) / 10}mm</b>입니다.</p>
    </div>`;
  }

  function saveLogSheet(r, mat, machine) {
    openSheet("테스트 기록 저장", `
      <p class="small muted" style="margin-top:0">${esc(mat.name)} · ${opLabel(r.op)} · 출력 ${r.powerPct}% · ${r.speedMmMin}mm/min · ${r.passes}패스</p>
      <label class="field"><span>결과</span>
        <select id="logResult">
          <option value="good">잘 됨 (이 값 그대로 사용)</option>
          <option value="adjust">조정 필요</option>
          <option value="fail">실패</option>
        </select>
      </label>
      <label class="field"><span>실제로 사용한 값 / 메모</span>
        <textarea id="logNote" rows="3" placeholder="예: 속도를 250으로 낮추니 깔끔하게 관통"></textarea>
      </label>
      <div class="btn-row"><button class="btn primary block" id="logSave">저장</button></div>`, (body) => {
      $("#logSave", body).addEventListener("click", () => {
        Store.addLog({
          material: mat.id, materialName: mat.name, op: r.op, thickness: r.thickness,
          machine: machineLabel(machine),
          powerPct: r.powerPct, speedMmMin: r.speedMmMin, passes: r.passes,
          result: $("#logResult", body).value, note: $("#logNote", body).value.trim(),
        });
        closeSheet(); toast("기록에 저장했습니다");
      });
    });
  }

  /* ============================ 재료 상점 ============================ */
  function renderShop() {
    const v = $("#view-shop");
    v.innerHTML = `
      <div class="card">
        <b>${esc(SHOP_CONFIG.seller)}</b>
        <p class="small muted" style="margin:6px 0 0">
          ${won(SHOP_CONFIG.freeShippingOver)} 이상 무료배송 · 그 미만 배송비 ${won(SHOP_CONFIG.shippingFee)}<br>
          주문은 장바구니에 담은 뒤 주문서를 보내주시면 확인 후 연락드립니다.</p>
      </div>
      <div class="section-title">소재</div>
      ${PRODUCTS.filter((p) => p.badge !== "소모품").map(productCard).join("")}
      <div class="section-title">소모품 · 액세서리</div>
      ${PRODUCTS.filter((p) => p.badge === "소모품").map(productCard).join("")}`;
    bindShop(v);
  }

  function productCard(p) {
    const mat = p.materialId ? LaserEngine.getMaterial(p.materialId) : null;
    const cat = mat ? mat.category : "metal";
    return `<div class="card prod">
      <div class="prod-head">
        <span class="prod-thumb sw-${cat}"></span>
        <div style="flex:1">
          <div class="row wrap"><b>${esc(p.name)}</b>${p.badge ? `<span class="pill">${esc(p.badge)}</span>` : ""}</div>
          <div class="small muted">${esc(p.desc)}</div>
        </div>
      </div>
      ${p.variants.map((v) => `
        <div class="variant ${v.stock === "out" ? "out" : ""}">
          <span class="vlabel">${esc(v.label)}<br><span class="small muted">${esc(STOCK_LABELS[v.stock])}</span></span>
          <span class="price">${won(v.price)}</span>
          <button class="add" data-add="${v.id}" data-prod="${p.id}" ${v.stock === "out" ? "disabled" : ""}>담기</button>
        </div>`).join("")}
      ${mat ? `<button class="btn ghost small" data-spec="${mat.id}">이 소재 설정값 보기</button>` : ""}
    </div>`;
  }

  function bindShop(root) {
    $$("button[data-add]", root).forEach((b) => b.addEventListener("click", () => {
      Store.addToCart(b.dataset.prod, b.dataset.add, 1);
      syncCart(); toast("장바구니에 담았습니다");
    }));
    $$("button[data-spec]", root).forEach((b) => b.addEventListener("click", () => {
      setView("calc"); selectMaterial(b.dataset.spec);
    }));
  }

  function productSheet(productId) {
    const p = PRODUCTS.find((x) => x.id === productId);
    if (!p) return;
    openSheet(p.name, `<div class="prod">${p.variants.map((v) => `
        <div class="variant ${v.stock === "out" ? "out" : ""}">
          <span class="vlabel">${esc(v.label)}<br><span class="small muted">${esc(STOCK_LABELS[v.stock])}</span></span>
          <span class="price">${won(v.price)}</span>
          <button class="add" data-add="${v.id}" data-prod="${p.id}" ${v.stock === "out" ? "disabled" : ""}>담기</button>
        </div>`).join("")}</div>`, (body) => bindShop(body));
  }

  function cartLines() {
    return Store.cart().map((item) => {
      const p = PRODUCTS.find((x) => x.id === item.productId);
      const v = p && p.variants.find((x) => x.id === item.variantId);
      if (!p || !v) return null;
      return { item, p, v, sum: v.price * item.qty };
    }).filter(Boolean);
  }
  function cartTotals() {
    const lines = cartLines();
    const goods = lines.reduce((a, l) => a + l.sum, 0);
    const ship = goods === 0 || goods >= SHOP_CONFIG.freeShippingOver ? 0 : SHOP_CONFIG.shippingFee;
    return { lines, goods, ship, total: goods + ship };
  }
  function syncCart() {
    const n = Store.cart().reduce((a, i) => a + i.qty, 0);
    const b = $("#cartBadge");
    b.textContent = n; b.hidden = n === 0;
  }

  function cartSheet() {
    const { lines, goods, ship, total } = cartTotals();
    if (!lines.length) {
      openSheet("장바구니", `<p class="muted">장바구니가 비어 있습니다.</p>
        <div class="btn-row"><button class="btn primary block" id="goShop">재료 보러 가기</button></div>`, (b) => {
        $("#goShop", b).addEventListener("click", () => { closeSheet(); setView("shop"); });
      });
      return;
    }
    openSheet("장바구니", `
      ${lines.map((l) => `
        <div class="cart-line">
          <div style="flex:1">
            <b class="small">${esc(l.p.name)}</b><br>
            <span class="small muted">${esc(l.v.label)}</span>
          </div>
          <div class="qty">
            <button data-dec="${l.v.id}">-</button><span>${l.item.qty}</span><button data-inc="${l.v.id}">+</button>
          </div>
          <div style="width:82px;text-align:right"><b>${won(l.sum)}</b><br>
            <button class="small muted" data-del="${l.v.id}">삭제</button></div>
        </div>`).join("")}
      <div class="total"><span>상품 합계</span><span>${won(goods)}</span></div>
      <div class="row small muted" style="justify-content:space-between"><span>배송비</span><span>${ship ? won(ship) : "무료"}</span></div>
      <div class="total"><span>결제 예정</span><span>${won(total)}</span></div>
      <div class="btn-row">
        <button class="btn" id="clearCart">비우기</button>
        <button class="btn primary" id="toOrder">주문서 작성</button>
      </div>`, (body) => {
      $$("button[data-inc]", body).forEach((b) => b.addEventListener("click", () => {
        const l = cartLines().find((x) => x.v.id === b.dataset.inc);
        Store.setQty(b.dataset.inc, l.item.qty + 1); syncCart(); cartSheet();
      }));
      $$("button[data-dec]", body).forEach((b) => b.addEventListener("click", () => {
        const l = cartLines().find((x) => x.v.id === b.dataset.dec);
        Store.setQty(b.dataset.dec, l.item.qty - 1); syncCart(); cartSheet();
      }));
      $$("button[data-del]", body).forEach((b) => b.addEventListener("click", () => {
        Store.removeFromCart(b.dataset.del); syncCart(); cartSheet();
      }));
      $("#clearCart", body).addEventListener("click", () => { Store.clearCart(); syncCart(); cartSheet(); });
      $("#toOrder", body).addEventListener("click", orderSheet);
    });
  }

  function buildOrderText(form) {
    const { lines, goods, ship, total } = cartTotals();
    const L = [];
    L.push(`[${SHOP_CONFIG.brand} 주문서]`);
    L.push(`주문일시: ${new Date().toLocaleString("ko-KR")}`);
    L.push("");
    lines.forEach((l) => L.push(`· ${l.p.name} / ${l.v.label} x ${l.item.qty} = ${won(l.sum)}`));
    L.push("");
    L.push(`상품합계 ${won(goods)} / 배송비 ${ship ? won(ship) : "무료"}`);
    L.push(`합계 ${won(total)}`);
    L.push("");
    L.push(`주문자: ${form.name}`);
    L.push(`연락처: ${form.phone}`);
    L.push(`주소: ${form.addr}`);
    if (form.memo) L.push(`요청사항: ${form.memo}`);
    if (form.machine) L.push(`사용 장비: ${form.machine}`);
    return L.join("\n");
  }

  function orderSheet() {
    const { total } = cartTotals();
    openSheet("주문서 작성", `
      <label class="field"><span>주문자 이름</span><input id="oName" autocomplete="name"></label>
      <label class="field"><span>연락처</span><input id="oPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="010-0000-0000"></label>
      <label class="field"><span>배송지 주소</span><textarea id="oAddr" rows="2" style="font-family:inherit;font-size:14px"></textarea></label>
      <label class="field"><span>요청사항 (선택)</span><input id="oMemo" placeholder="예: 부재 시 경비실"></label>
      <div class="note">보유 장비(${esc(machineLabel(Store.machine()))}) 정보도 함께 전달되어 소재 추천에 활용됩니다.</div>
      <div class="total"><span>합계</span><span>${won(total)}</span></div>
      <div class="btn-row"><button class="btn primary block" id="oSend">주문서 보내기</button></div>
      <div class="btn-row">
        <button class="btn" id="oCopy">내용 복사</button>
        <button class="btn" id="oMail">메일로 보내기</button>
      </div>
      <p class="small muted">입금 계좌: ${esc(SHOP_CONFIG.bank)}</p>`, (body) => {
      const getForm = () => ({
        name: $("#oName", body).value.trim(),
        phone: $("#oPhone", body).value.trim(),
        addr: $("#oAddr", body).value.trim(),
        memo: $("#oMemo", body).value.trim(),
        machine: machineLabel(Store.machine()),
      });
      const validate = (f) => {
        if (!f.name || !f.phone || !f.addr) { toast("이름·연락처·주소를 입력하세요"); return false; }
        return true;
      };
      $("#oSend", body).addEventListener("click", () => {
        const f = getForm(); if (!validate(f)) return;
        const text = buildOrderText(f);
        if (SHOP_CONFIG.orderEndpoint) {
          fetch(SHOP_CONFIG.orderEndpoint, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ form: f, items: cartLines().map((l) => ({ product: l.p.name, variant: l.v.label, qty: l.item.qty, price: l.v.price })), text }),
          }).then((r) => {
            if (!r.ok) throw new Error("전송 실패");
            Store.clearCart(); syncCart(); closeSheet(); toast("주문서를 보냈습니다");
          }).catch(() => toast("전송에 실패했습니다. 복사 후 카톡·문자로 보내주세요"));
          return;
        }
        if (navigator.share) {
          navigator.share({ title: SHOP_CONFIG.brand + " 주문서", text }).then(() => {
            toast("주문서를 전달했습니다");
          }).catch(() => {});
        } else {
          copy(text);
          window.open(SHOP_CONFIG.kakaoChannel, "_blank");
        }
      });
      $("#oCopy", body).addEventListener("click", () => copy(buildOrderText(getForm())));
      $("#oMail", body).addEventListener("click", () => {
        const f = getForm(); if (!validate(f)) return;
        location.href = `mailto:${SHOP_CONFIG.email}?subject=${encodeURIComponent("[주문] " + SHOP_CONFIG.brand)}&body=${encodeURIComponent(buildOrderText(f))}`;
      });
    });
  }

  /* ============================ 테스트 그리드 ============================ */
  function renderGrid() {
    const v = $("#view-grid");
    const machine = Store.machine();
    const r = state.lastResult;
    const base = r && r.ok ? r : null;
    const sMid = base ? base.speedMmMin : 1000;
    const pMid = base ? base.powerPct : 60;
    const d = {
      speedFrom: Math.max(30, Math.round(sMid * 0.4 / 10) * 10),
      speedTo: Math.min(Math.round(machine.maxSpeed * 60), Math.round(sMid * 1.8 / 10) * 10),
      powerFrom: Math.max(5, Math.round(pMid * 0.5)),
      powerTo: Math.min(100, Math.round(pMid * 1.3)),
    };
    v.innerHTML = `
      <div class="card">
        <h3>파워 x 속도 테스트 그리드</h3>
        <p class="small muted" style="margin:6px 0 0">
          새 소재를 받으면 이 G코드를 한 번 돌려보세요. 가장 잘 나온 칸의 값이 그 소재의 정답입니다.
          ${base ? `현재 계산값(<b>${base.powerPct}% · ${base.speedMmMin}mm/min</b>) 주변으로 범위를 잡아 두었습니다.` : ""}
        </p>
      </div>
      <div class="card">
        <div class="grid2">
          <label class="field"><span>출력 시작 (%)</span><input type="number" id="gPf" value="${d.powerFrom}" min="1" max="100"></label>
          <label class="field"><span>출력 끝 (%)</span><input type="number" id="gPt" value="${d.powerTo}" min="1" max="100"></label>
          <label class="field"><span>속도 시작 (mm/min)</span><input type="number" id="gSf" value="${d.speedFrom}" min="10" step="10"></label>
          <label class="field"><span>속도 끝 (mm/min)</span><input type="number" id="gSt" value="${d.speedTo}" min="10" step="10"></label>
          <label class="field"><span>단계 수 (세로 x 가로)</span><input type="number" id="gSteps" value="5" min="2" max="10"></label>
          <label class="field"><span>칸 크기 (mm)</span><input type="number" id="gCell" value="10" min="3" max="30"></label>
          <label class="field"><span>패스</span><input type="number" id="gPass" value="1" min="1" max="10"></label>
          <label class="field"><span>S값 최대</span>
            <select id="gS"><option value="1000">1000 (GRBL 기본)</option><option value="255">255 (LaserGRBL 일부)</option><option value="100">100</option></select>
          </label>
          <label class="field"><span>레이저 모드</span>
            <select id="gMode"><option value="M4">M4 (다이나믹, 권장)</option><option value="M3">M3 (고정)</option></select>
          </label>
          <label class="field"><span>채우기</span>
            <select id="gFill"><option value="1">면 채우기 (조각 테스트)</option><option value="0">외곽선만 (절단 테스트)</option></select>
          </label>
        </div>
        <div class="btn-row"><button class="btn primary block" id="gMake">G코드 만들기</button></div>
      </div>
      <div id="gOut"></div>`;
    $("#gMake", v).addEventListener("click", makeGrid);
  }

  function makeGrid() {
    const steps = Math.max(2, Math.min(10, parseInt($("#gSteps").value, 10) || 5));
    const opt = {
      powerFrom: parseFloat($("#gPf").value), powerTo: parseFloat($("#gPt").value), powerSteps: steps,
      speedFrom: parseFloat($("#gSf").value), speedTo: parseFloat($("#gSt").value), speedSteps: steps,
      cell: parseFloat($("#gCell").value) || 10, passes: parseInt($("#gPass").value, 10) || 1,
      sMax: parseInt($("#gS").value, 10), mode: $("#gMode").value, fill: $("#gFill").value === "1",
    };
    const g = TestGrid.build(opt);
    const mat = state.materialId ? LaserEngine.getMaterial(state.materialId) : null;
    const fname = `testgrid_${mat ? mat.id : "material"}_${opt.speedFrom}-${opt.speedTo}.nc`;

    const cells = [];
    cells.push(`<div class="hdr"></div>`);
    g.speeds.forEach((s) => cells.push(`<div class="hdr">${s}</div>`));
    g.powers.slice().reverse().forEach((p) => {
      cells.push(`<div class="hdr">${p}%</div>`);
      g.speeds.forEach(() => cells.push(`<div>&nbsp;</div>`));
    });

    $("#gOut").innerHTML = `
      <div class="card">
        <div class="section-title" style="margin-top:0">배치 미리보기 · 전체 ${g.width} x ${g.height} mm</div>
        <div class="matrix" style="grid-template-columns:44px repeat(${g.speeds.length},1fr)">${cells.join("")}</div>
        <p class="small muted">가로 = 속도(mm/min), 세로 = 출력(%). 원점은 왼쪽 아래입니다.</p>
        <textarea class="gcode-out" id="gText" readonly>${esc(g.gcode)}</textarea>
        <div class="btn-row">
          <button class="btn" id="gCopy">복사</button>
          <button class="btn primary" id="gDl">.nc 파일 저장</button>
        </div>
        <div class="warn">테스트 중에는 절대 자리를 비우지 마세요. 소화기를 손 닿는 곳에 두세요.</div>
      </div>`;
    $("#gCopy").addEventListener("click", () => copy(g.gcode));
    $("#gDl").addEventListener("click", () => download(fname, g.gcode));
  }

  /* ============================ 내 기록 ============================ */
  function renderLog() {
    const v = $("#view-log");
    const log = Store.log();
    v.innerHTML = `
      <div class="card">
        <h3>내 테스트 기록</h3>
        <p class="small muted" style="margin:6px 0 0">직접 확인한 값을 저장해 두면 다음 작업에서 바로 꺼내 쓸 수 있습니다. 기록은 이 기기에만 저장됩니다.</p>
        ${log.length ? `<div class="btn-row">
          <button class="btn" id="logExport">내보내기</button>
          <button class="btn" id="logClear">전체 삭제</button></div>` : ""}
      </div>
      ${log.length ? `<div class="card">${log.map(logItem).join("")}</div>`
        : `<div class="card muted">아직 저장한 기록이 없습니다. 설정 화면에서 <b>기록 저장</b>을 눌러보세요.</div>`}`;
    $$("button[data-dellog]", v).forEach((b) => b.addEventListener("click", () => {
      Store.removeLog(b.dataset.dellog); renderLog();
    }));
    $$("button[data-uselog]", v).forEach((b) => b.addEventListener("click", () => {
      const e = Store.log().find((x) => x.id === b.dataset.uselog);
      if (e) { setView("calc"); selectMaterial(e.material); }
    }));
    if (log.length) {
      $("#logExport", v).addEventListener("click", () =>
        download("laser-settings-log.json", JSON.stringify(log, null, 2), "application/json"));
      $("#logClear", v).addEventListener("click", () => {
        if (confirm("모든 기록을 삭제할까요?")) { Store.set("log", []); renderLog(); }
      });
    }
  }

  function logItem(e) {
    const pill = e.result === "good" ? `<span class="pill ok">잘 됨</span>`
      : e.result === "adjust" ? `<span class="pill warn">조정 필요</span>` : `<span class="pill bad">실패</span>`;
    return `<div class="log-item">
      <div class="row wrap"><b style="flex:1">${esc(e.materialName)}${e.thickness ? " " + e.thickness + "mm" : ""} · ${opLabel(e.op)}</b>${pill}</div>
      <div class="small">출력 ${e.powerPct}% · ${e.speedMmMin}mm/min · ${e.passes}패스 <span class="muted">(${esc(e.machine)})</span></div>
      ${e.note ? `<div class="small muted">${esc(e.note)}</div>` : ""}
      <div class="row" style="margin-top:4px">
        <span class="t">${new Date(e.ts).toLocaleString("ko-KR")}</span><span class="spacer"></span>
        <button class="chip" data-uselog="${e.id}">다시 계산</button>
        <button class="chip" data-dellog="${e.id}">삭제</button>
      </div>
    </div>`;
  }

  /* ============================ 안전 · 정보 ============================ */
  function renderSafety() {
    const v = $("#view-safety");
    v.innerHTML = `
      <div class="card">
        <h3>절대 가공하면 안 되는 소재</h3>
        <p class="small muted" style="margin:6px 0 0">아래 소재는 유독가스가 발생하거나 장비를 망가뜨립니다. 성분을 모르는 소재는 자르지 마세요.</p>
      </div>
      ${FORBIDDEN.map((f) => `
        <div class="card">
          <div class="row wrap"><b style="flex:1">${esc(f.name)}</b><span class="pill bad">금지</span></div>
          <div class="danger">${esc(f.reason)}</div>
          <button class="btn ghost small" data-alt2="${f.alt}" style="margin-top:8px">대체 소재 보기</button>
        </div>`).join("")}
      <div class="card">
        <h3>작업 전 점검</h3>
        <ul class="small" style="margin:8px 0 0;padding-left:18px;line-height:1.9">
          <li>배기(환기)를 켜고, 실내로 연기가 새지 않는지 확인합니다.</li>
          <li>소화기 또는 젖은 수건을 손 닿는 곳에 둡니다.</li>
          <li>작동 중에는 자리를 비우지 않습니다. 화재는 대부분 눈을 뗀 30초 사이에 시작됩니다.</li>
          <li>다이오드 장비는 반드시 해당 파장용 보호 안경을 쓰고, 개방형이면 차폐를 설치합니다.</li>
          <li>초점과 렌즈 상태를 확인합니다. 렌즈가 더러우면 같은 설정에서도 절단이 안 됩니다.</li>
          <li>성분을 모르는 소재는 판매처에 재질을 확인한 뒤 가공합니다.</li>
        </ul>
      </div>
      <div class="card">
        <h3>앱 설치</h3>
        <p class="small muted" style="margin:6px 0 8px">홈 화면에 설치하면 인터넷 없이도 설정값을 볼 수 있습니다.</p>
        <button class="btn primary block" id="installBtn" ${deferredPrompt ? "" : "disabled"}>홈 화면에 설치</button>
        <p class="small muted" style="margin:10px 0 0">
          아이폰(Safari): 공유 버튼 → <b>홈 화면에 추가</b><br>
          안드로이드(Chrome): 우측 상단 메뉴 → <b>앱 설치</b>
        </p>
      </div>
      <div class="card">
        <h3>문의</h3>
        <p class="small" style="margin:6px 0 10px">
          ${esc(SHOP_CONFIG.seller)}<br>
          <span class="muted">전화</span> ${esc(SHOP_CONFIG.phone)}<br>
          <span class="muted">메일</span> ${esc(SHOP_CONFIG.email)}
        </p>
        <div class="btn-row">
          <button class="btn" id="callBtn">전화</button>
          <button class="btn" id="kakaoBtn">카카오 문의</button>
        </div>
      </div>
      <div class="card small muted">
        레이저 소재 가이드 v${esc(APP_VERSION)} · 표시값은 시작값이며 실제 결과는 렌즈·초점·소재 편차에 따라 달라집니다.
        <div class="btn-row"><button class="btn ghost" id="resetAll">앱 데이터 초기화</button></div>
      </div>`;
    $$("button[data-alt2]", v).forEach((b) => b.addEventListener("click", () => {
      setView("calc"); selectMaterial(b.dataset.alt2);
    }));
    $("#callBtn", v).addEventListener("click", () => { location.href = "tel:" + SHOP_CONFIG.phone.replace(/[^0-9+]/g, ""); });
    $("#kakaoBtn", v).addEventListener("click", () => window.open(SHOP_CONFIG.kakaoChannel, "_blank"));
    $("#installBtn", v).addEventListener("click", doInstall);
    $("#resetAll", v).addEventListener("click", () => {
      if (confirm("장비 설정·장바구니·기록을 모두 지울까요?")) {
        ["machine", "cart", "log", "fav"].forEach((k) => localStorage.removeItem("lmg." + k));
        location.reload();
      }
    });
  }

  /* ============================ 설치(PWA) ============================ */
  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (state.view === "safety") renderSafety();
  });
  function doInstall() {
    if (!deferredPrompt) { toast("브라우저 메뉴에서 '홈 화면에 추가'를 눌러주세요"); return; }
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(() => { deferredPrompt = null; });
  }

  /* ============================ 시작 ============================ */
  function init() {
    $("#brandText").textContent = SHOP_CONFIG.brand;
    document.title = SHOP_CONFIG.brand;
    syncMachineChip();
    syncCart();
    $("#machineBtn").addEventListener("click", machineSheet);
    $("#cartBtn").addEventListener("click", cartSheet);
    $("#brandBtn").addEventListener("click", () => setView("calc"));
    $("#sheetClose").addEventListener("click", closeSheet);
    $("#sheetBackdrop").addEventListener("click", closeSheet);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
    $$("#tabbar button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
    setView("calc");
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
