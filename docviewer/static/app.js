/* docviewer frontend - plain ES2018, no build step, no external assets. */
"use strict";

var KIND_ICONS = {
  pdf: "📕", image: "🖼️", document: "📘", spreadsheet: "📗",
  presentation: "📙", text: "📄", legacy: "🗂️"
};

var state = {
  config: null,
  cwd: "",
  files: [],
  filtered: [],
  current: null,
  payload: null,
  zoom: 1,
  sheet: 0,
  slide: 0,
  fitImage: true,
  rotation: 0,
  notes: false
};

var dom = {};

document.addEventListener("DOMContentLoaded", function () {
  ["sidebar", "breadcrumbs", "filter", "file-list", "content", "tools", "current-name",
   "current-meta", "current-icon", "counts", "root-label", "converter-state", "toast",
   "toggle-theme", "toggle-sidebar"].forEach(function (id) {
    dom[id] = document.getElementById(id);
  });
  restoreTheme();
  bindEvents();
  start();
});

function bindEvents() {
  dom["toggle-theme"].addEventListener("click", toggleTheme);
  dom["toggle-sidebar"].addEventListener("click", function () {
    document.body.classList.toggle("sidebar-hidden");
  });
  dom.filter.addEventListener("input", function () {
    renderFileList();
  });
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", debounce(function () {
    if (state.payload && state.payload.kind === "presentation") { layoutSlide(); }
  }, 120));
  window.addEventListener("popstate", function () {
    var file = new URLSearchParams(location.search).get("file");
    if (file) { openPath(file, false); }
  });
}

function start() {
  api("/api/config").then(function (config) {
    state.config = config;
    dom["root-label"].textContent = shortenPath(config.root);
    dom["root-label"].title = config.root;
    dom["converter-state"].textContent = config.converter ? "변환기 있음" : "";
    dom["converter-state"].title = config.converter
      ? "LibreOffice 가 있어 doc/xls/ppt/odt 도 볼 수 있습니다."
      : "";
    var requested = new URLSearchParams(location.search).get("file") || config.initial || "";
    var directory = requested ? requested.split("/").slice(0, -1).join("/") : "";
    return browse(directory).then(function () {
      if (requested) { return openPath(requested, false); }
    });
  }).catch(function (error) {
    showMessage("시작하지 못했습니다", error.message, true);
  });
}

/* -- data ---------------------------------------------------------------- */

function api(url) {
  return fetch(url, { headers: { "Accept": "application/json" } }).then(function (response) {
    return response.json().catch(function () {
      throw new Error("서버 응답을 해석할 수 없습니다 (" + response.status + ")");
    }).then(function (data) {
      if (!response.ok || data.error) {
        throw new Error(data.error || ("요청이 실패했습니다 (" + response.status + ")"));
      }
      return data;
    });
  });
}

function browse(path) {
  return api("/api/browse?path=" + encodeURIComponent(path || "")).then(function (data) {
    state.cwd = data.path;
    state.listing = data;
    state.files = data.files;
    renderBreadcrumbs(data);
    renderFileList();
    return data;
  }).catch(function (error) {
    toast(error.message);
  });
}

/* -- sidebar ------------------------------------------------------------- */

function renderBreadcrumbs(data) {
  dom.breadcrumbs.textContent = "";
  data.breadcrumbs.forEach(function (crumb, index) {
    if (index > 0) {
      var separator = document.createElement("span");
      separator.className = "sep";
      separator.textContent = "›";
      dom.breadcrumbs.appendChild(separator);
    }
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = crumb.name;
    button.addEventListener("click", function () { browse(crumb.path); });
    dom.breadcrumbs.appendChild(button);
  });
}

function renderFileList() {
  var data = state.listing;
  if (!data) { return; }
  var needle = dom.filter.value.trim().toLowerCase();
  var directories = data.directories.filter(function (item) {
    return !needle || item.name.toLowerCase().indexOf(needle) >= 0;
  });
  state.filtered = data.files.filter(function (item) {
    return !needle || item.name.toLowerCase().indexOf(needle) >= 0;
  });
  dom["file-list"].textContent = "";
  if (data.parent !== null && data.parent !== undefined) {
    dom["file-list"].appendChild(entryButton("📁", "..", "", function () {
      browse(data.parent);
    }));
  }
  if (directories.length) {
    dom["file-list"].appendChild(groupTitle("폴더"));
    directories.forEach(function (item) {
      dom["file-list"].appendChild(entryButton("📁", item.name, "", function () {
        browse(item.path);
      }));
    });
  }
  if (state.filtered.length) {
    dom["file-list"].appendChild(groupTitle("파일"));
    state.filtered.forEach(function (item) {
      var button = entryButton(KIND_ICONS[item.kind] || "📄", item.name, formatSize(item.size),
        function () { openFile(item); });
      button.dataset.path = item.path;
      if (state.current && state.current.path === item.path) {
        button.classList.add("active");
      }
      dom["file-list"].appendChild(button);
    });
  }
  if (!directories.length && !state.filtered.length) {
    var empty = document.createElement("p");
    empty.className = "hint";
    empty.style.padding = "16px 10px";
    empty.textContent = needle ? "검색 결과가 없습니다." : "볼 수 있는 파일이 없습니다.";
    dom["file-list"].appendChild(empty);
  }
  dom.counts.textContent = "폴더 " + directories.length + " · 파일 " + state.filtered.length;
}

function groupTitle(text) {
  var element = document.createElement("div");
  element.className = "group-title";
  element.textContent = text;
  return element;
}

function entryButton(icon, name, size, handler) {
  var button = document.createElement("button");
  button.type = "button";
  button.className = "entry";
  button.title = name;
  var iconSpan = document.createElement("span");
  iconSpan.className = "entry-icon";
  iconSpan.textContent = icon;
  var nameSpan = document.createElement("span");
  nameSpan.className = "entry-name";
  nameSpan.textContent = name;
  var sizeSpan = document.createElement("span");
  sizeSpan.className = "entry-size";
  sizeSpan.textContent = size;
  button.appendChild(iconSpan);
  button.appendChild(nameSpan);
  button.appendChild(sizeSpan);
  button.addEventListener("click", handler);
  return button;
}

/* -- opening files ------------------------------------------------------- */

function openPath(path, push) {
  var name = path.split("/").pop();
  return openFile({ path: path, name: name, kind: null, size: null }, push);
}

function openFile(entry, push) {
  state.current = entry;
  state.zoom = 1;
  state.sheet = 0;
  state.slide = 0;
  state.rotation = 0;
  state.fitImage = true;
  markActive(entry.path);
  dom["current-name"].textContent = entry.name;
  dom["current-meta"].textContent = "";
  dom["current-icon"].textContent = "";
  dom.tools.textContent = "";
  dom.content.innerHTML = "<div class=\"spinner\"></div>";
  if (push !== false) {
    history.pushState({ file: entry.path }, "", "?file=" + encodeURIComponent(entry.path));
  }
  return api("/api/document?path=" + encodeURIComponent(entry.path)).then(function (payload) {
    state.payload = payload;
    state.current = Object.assign({}, entry, payload.file || {});
    renderPayload(payload);
  }).catch(function (error) {
    showMessage("파일을 열지 못했습니다", error.message, true);
  });
}

function markActive(path) {
  var buttons = dom["file-list"].querySelectorAll(".entry");
  Array.prototype.forEach.call(buttons, function (button) {
    button.classList.toggle("active", button.dataset.path === path);
  });
}

function renderPayload(payload) {
  var file = payload.file || {};
  document.title = (file.name || "문서") + " · 문서 뷰어";
  dom["current-name"].textContent = file.name || "";
  dom["current-icon"].textContent = file.label || "";
  var meta = [];
  if (file.size !== null && file.size !== undefined) { meta.push(formatSize(file.size)); }
  if (file.modified) { meta.push(formatDate(file.modified)); }
  if (payload.converted) { meta.push("변환됨"); }
  dom["current-meta"].textContent = meta.join(" · ");
  dom.content.textContent = "";
  dom.tools.textContent = "";
  var renderers = {
    pdf: renderPdf, image: renderImage, document: renderDocument,
    spreadsheet: renderSpreadsheet, presentation: renderPresentation, text: renderText
  };
  var renderer = renderers[payload.kind];
  if (renderer) {
    buildCommonTools();
    renderer(payload);
    renderWarnings(payload);
  } else if (payload.kind === "unsupported") {
    buildCommonTools();
    showMessage("이 형식은 바로 볼 수 없습니다", payload.message || "", false);
  } else {
    buildCommonTools();
    showMessage("파일을 표시할 수 없습니다", payload.message || "알 수 없는 오류입니다.", true);
  }
}

function renderWarnings(payload) {
  if (!payload.warnings || !payload.warnings.length) { return; }
  var box = document.createElement("div");
  box.className = "warnings";
  box.textContent = "⚠ " + payload.warnings.join(" / ");
  dom.content.insertBefore(box, dom.content.firstChild);
}

/* -- tools --------------------------------------------------------------- */

function buildCommonTools() {
  var path = state.current ? state.current.path : "";
  addTool("⤓ 저장", function () {
    window.location.href = "/file?download=1&path=" + encodeURIComponent(path);
  }, "파일을 내려받습니다");
  addTool("↗ 새 창", function () {
    window.open(fileUrl(path, state.current ? state.current.name : ""), "_blank", "noopener");
  }, "브라우저 새 탭에서 원본을 엽니다");
}

function fileUrl(path, name) {
  var suffix = name ? "/" + encodeURIComponent(name) : "";
  return "/file" + suffix + "?path=" + encodeURIComponent(path);
}

function addTool(label, handler, title) {
  var button = document.createElement("button");
  button.type = "button";
  button.className = "tool-button";
  button.textContent = label;
  if (title) { button.title = title; }
  button.addEventListener("click", handler);
  dom.tools.appendChild(button);
  return button;
}

function addDivider() {
  var divider = document.createElement("span");
  divider.className = "divider";
  dom.tools.appendChild(divider);
}

function addZoomTools(apply, options) {
  options = options || {};
  state.zoomApply = apply;
  addDivider();
  addTool("−", function () { changeZoom(-0.1, apply); }, "축소");
  var label = document.createElement("span");
  label.className = "zoom-label";
  label.textContent = "100%";
  dom.tools.appendChild(label);
  state.zoomLabel = label;
  addTool("+", function () { changeZoom(0.1, apply); }, "확대");
  addTool(options.resetLabel || "100%", function () {
    state.zoom = 1;
    if (options.onReset) { options.onReset(); }
    apply();
    updateZoomLabel();
  }, "원래 크기");
  updateZoomLabel();
}

function changeZoom(delta, apply) {
  state.zoom = Math.min(4, Math.max(0.25, Math.round((state.zoom + delta) * 100) / 100));
  apply();
  updateZoomLabel();
}

function updateZoomLabel() {
  if (state.zoomLabel) {
    state.zoomLabel.textContent = Math.round(state.zoom * 100) + "%";
  }
}

/* -- renderers ----------------------------------------------------------- */

function renderPdf(payload) {
  var frame = document.createElement("iframe");
  frame.className = "pdf-frame";
  frame.title = payload.file.name;
  frame.src = fileUrl(payload.file.path, payload.file.name) + "#view=FitH";
  dom.content.style.padding = "10px";
  dom.content.appendChild(frame);
}

function renderImage(payload) {
  dom.content.style.padding = "18px";
  var stage = document.createElement("div");
  stage.className = "image-stage fit";
  var image = document.createElement("img");
  image.alt = payload.file.name;
  image.src = fileUrl(payload.file.path, payload.file.name);
  image.addEventListener("load", function () {
    dom["current-meta"].textContent += " · " + image.naturalWidth + "×" + image.naturalHeight;
  });
  stage.appendChild(image);
  dom.content.appendChild(stage);

  function apply() {
    stage.classList.toggle("fit", state.fitImage && state.zoom === 1 && !state.rotation);
    image.style.transform = "scale(" + state.zoom + ") rotate(" + state.rotation + "deg)";
  }

  addDivider();
  var fitButton = addTool("화면 맞춤", function () {
    state.fitImage = !state.fitImage;
    state.zoom = 1;
    fitButton.setAttribute("aria-pressed", String(state.fitImage));
    apply();
    updateZoomLabel();
  }, "창 크기에 맞춥니다");
  fitButton.setAttribute("aria-pressed", "true");
  addTool("↻ 회전", function () {
    state.rotation = (state.rotation + 90) % 360;
    apply();
  }, "90도 회전");
  addZoomTools(function () { state.fitImage = false; apply(); },
    { onReset: function () { state.fitImage = true; state.rotation = 0; } });
  apply();
}

function renderDocument(payload) {
  var page = document.createElement("article");
  page.className = "doc-page";
  page.innerHTML = payload.html || "";
  dom.content.appendChild(page);
  appendProperties(payload);
  addZoomTools(function () {
    page.style.setProperty("--doc-zoom", state.zoom);
  });
}

function renderText(payload) {
  var page = document.createElement("div");
  page.className = "text-page";
  var pre = document.createElement("pre");
  pre.textContent = payload.text || "";
  page.appendChild(pre);
  if (payload.truncated) {
    var note = document.createElement("p");
    note.className = "hint";
    note.textContent = "파일이 커서 앞부분만 표시했습니다.";
    page.appendChild(note);
  }
  dom.content.appendChild(page);
  addZoomTools(function () {
    page.style.setProperty("--doc-zoom", state.zoom);
  });
}

function renderSpreadsheet(payload) {
  var sheets = payload.sheets || [];
  if (!sheets.length) {
    showMessage("표시할 시트가 없습니다", "", false);
    return;
  }
  var tabs = document.createElement("div");
  tabs.className = "sheet-tabs";
  var wrap = document.createElement("div");
  wrap.className = "grid-wrap";
  dom.content.appendChild(tabs);
  dom.content.appendChild(wrap);
  appendProperties(payload);

  function show(index) {
    state.sheet = index;
    Array.prototype.forEach.call(tabs.children, function (tab, position) {
      tab.setAttribute("aria-selected", String(position === index));
    });
    wrap.textContent = "";
    wrap.appendChild(buildGrid(sheets[index]));
    wrap.style.setProperty("--doc-zoom", state.zoom);
  }

  sheets.forEach(function (sheet, index) {
    var tab = document.createElement("button");
    tab.type = "button";
    tab.className = "sheet-tab";
    tab.setAttribute("role", "tab");
    tab.textContent = sheet.name;
    tab.addEventListener("click", function () { show(index); });
    tabs.appendChild(tab);
  });
  if (sheets.length === 1) { tabs.style.display = "none"; }
  addZoomTools(function () { wrap.style.setProperty("--doc-zoom", state.zoom); });
  show(0);
}

function buildGrid(sheet) {
  var rows = sheet.rows || [];
  var columns = 0;
  rows.forEach(function (row) { columns = Math.max(columns, row.length); });
  var skip = {};
  (sheet.merges || []).forEach(function (merge) {
    for (var r = merge.r; r < merge.r + merge.rs; r++) {
      for (var c = merge.c; c < merge.c + merge.cs; c++) {
        if (r !== merge.r || c !== merge.c) { skip[r + ":" + c] = true; }
      }
    }
  });
  var spans = {};
  (sheet.merges || []).forEach(function (merge) {
    spans[merge.r + ":" + merge.c] = merge;
  });

  var table = document.createElement("table");
  table.className = "grid";
  var head = document.createElement("thead");
  var headRow = document.createElement("tr");
  headRow.appendChild(document.createElement("th"));
  for (var index = 0; index < columns; index++) {
    var th = document.createElement("th");
    th.textContent = columnName(index);
    if (sheet.widths && sheet.widths[index]) {
      th.style.minWidth = Math.min(sheet.widths[index], 400) + "px";
    }
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  table.appendChild(head);

  var body = document.createElement("tbody");
  rows.forEach(function (row, rowIndex) {
    var tr = document.createElement("tr");
    var rowHeader = document.createElement("th");
    rowHeader.textContent = String(rowIndex + 1);
    tr.appendChild(rowHeader);
    for (var column = 0; column < columns; column++) {
      if (skip[rowIndex + ":" + column]) { continue; }
      var cell = row[column];
      var td = document.createElement("td");
      var merge = spans[rowIndex + ":" + column];
      if (merge) {
        if (merge.rs > 1) { td.rowSpan = merge.rs; }
        if (merge.cs > 1) { td.colSpan = merge.cs; }
      }
      if (cell) {
        td.textContent = cell.v;
        if (cell.n) { td.className = "num"; }
        if (cell.e) { td.className = "err"; }
      }
      tr.appendChild(td);
    }
    body.appendChild(tr);
  });
  table.appendChild(body);
  if (sheet.truncated) {
    var caption = document.createElement("caption");
    caption.style.captionSide = "bottom";
    caption.style.padding = "6px";
    caption.style.color = "var(--text-muted)";
    caption.textContent = "표가 커서 일부만 표시했습니다.";
    table.appendChild(caption);
  }
  return table;
}

function columnName(index) {
  var name = "";
  index += 1;
  while (index > 0) {
    var remainder = (index - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    index = Math.floor((index - 1) / 26);
  }
  return name;
}

function renderPresentation(payload) {
  var layout = document.createElement("div");
  layout.className = "slide-layout";
  var rail = document.createElement("div");
  rail.className = "slide-rail";
  var main = document.createElement("div");
  main.className = "slide-main";
  var stageWrap = document.createElement("div");
  stageWrap.className = "slide-stage-wrap";
  var stage = document.createElement("div");
  stage.className = "slide-stage";
  stage.style.width = payload.width + "px";
  stage.style.height = payload.height + "px";
  stageWrap.appendChild(stage);
  main.appendChild(stageWrap);
  var notes = document.createElement("div");
  notes.className = "slide-notes";
  notes.hidden = true;
  main.appendChild(notes);
  layout.appendChild(rail);
  layout.appendChild(main);
  dom.content.appendChild(layout);
  appendProperties(payload);

  state.slideElements = { stage: stage, stageWrap: stageWrap, rail: rail, notes: notes };

  payload.slides.forEach(function (slide, index) {
    var thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "slide-thumb";
    var number = document.createElement("span");
    number.className = "num";
    number.textContent = "슬라이드 " + (index + 1);
    thumb.appendChild(number);
    thumb.appendChild(document.createTextNode(slide.title || "(제목 없음)"));
    thumb.addEventListener("click", function () { showSlide(index); });
    rail.appendChild(thumb);
  });

  addDivider();
  addTool("◀", function () { showSlide(state.slide - 1); }, "이전 슬라이드 (←)");
  addTool("▶", function () { showSlide(state.slide + 1); }, "다음 슬라이드 (→)");
  var notesButton = addTool("발표자 노트", function () {
    state.notes = !state.notes;
    notesButton.setAttribute("aria-pressed", String(state.notes));
    layoutSlide();
  }, "슬라이드 노트를 보여줍니다");
  notesButton.setAttribute("aria-pressed", "false");
  addZoomTools(layoutSlide);
  showSlide(0);
}

function showSlide(index) {
  var payload = state.payload;
  if (!payload || !payload.slides || !payload.slides.length) { return; }
  index = Math.min(payload.slides.length - 1, Math.max(0, index));
  state.slide = index;
  var slide = payload.slides[index];
  var elements = state.slideElements;
  elements.stage.textContent = "";
  slide.shapes.forEach(function (shape) {
    var box = document.createElement("div");
    box.className = "slide-shape";
    if (shape.x !== null && shape.x !== undefined) {
      box.style.left = shape.x + "px";
      box.style.top = shape.y + "px";
      box.style.width = shape.w + "px";
      box.style.height = shape.h + "px";
    } else {
      box.style.position = "static";
      box.style.padding = "12px";
    }
    if (shape.rot) { box.style.transform = "rotate(" + shape.rot + "deg)"; }
    if (shape.kind === "image") {
      var image = document.createElement("img");
      image.src = shape.src;
      image.alt = "";
      image.loading = "lazy";
      box.appendChild(image);
    } else {
      box.innerHTML = shape.html || "";
    }
    elements.stage.appendChild(box);
  });
  Array.prototype.forEach.call(elements.rail.children, function (thumb, position) {
    thumb.setAttribute("aria-current", String(position === index));
    if (position === index) { scrollIntoViewIfNeeded(thumb, elements.rail); }
  });
  elements.notes.textContent = "";
  if (state.notes && slide.notes) {
    var title = document.createElement("h3");
    title.textContent = "발표자 노트";
    elements.notes.appendChild(title);
    elements.notes.appendChild(document.createTextNode(slide.notes));
  }
  elements.notes.hidden = !(state.notes && slide.notes);
  dom["current-meta"].textContent = formatSize(state.current.size) + " · 슬라이드 "
    + (index + 1) + " / " + payload.slides.length;
  layoutSlide();
}

function layoutSlide() {
  var payload = state.payload;
  var elements = state.slideElements;
  if (!payload || !elements || payload.kind !== "presentation") { return; }
  var available = elements.stageWrap.clientWidth - 24;
  var scale = Math.max(0.1, Math.min(available / payload.width, 1.6)) * state.zoom;
  elements.stage.style.transform = "scale(" + scale + ")";
  elements.stageWrap.style.height = (payload.height * scale + 24) + "px";
  elements.stage.style.marginRight = (payload.width * (scale - 1)) + "px";
  var slide = payload.slides[state.slide];
  elements.notes.hidden = !(state.notes && slide && slide.notes);
}

function scrollIntoViewIfNeeded(element, container) {
  var top = element.offsetTop - container.offsetTop;
  if (top < container.scrollTop || top + element.offsetHeight > container.scrollTop
      + container.clientHeight) {
    container.scrollTop = top - 8;
  }
}

function appendProperties(payload) {
  var properties = payload.properties || {};
  var keys = Object.keys(properties);
  if (!keys.length) { return; }
  var box = document.createElement("div");
  box.className = "properties";
  keys.forEach(function (key) {
    var item = document.createElement("span");
    item.textContent = key + ": " + properties[key];
    box.appendChild(item);
  });
  dom.content.appendChild(box);
}

function showMessage(title, detail, isError) {
  dom.content.textContent = "";
  var card = document.createElement("div");
  card.className = "message-card" + (isError ? " error" : "");
  var heading = document.createElement("h2");
  heading.textContent = title;
  card.appendChild(heading);
  if (detail) {
    var paragraph = document.createElement("p");
    paragraph.textContent = detail;
    card.appendChild(paragraph);
  }
  if (state.current && state.current.path) {
    var link = document.createElement("a");
    link.href = "/file?download=1&path=" + encodeURIComponent(state.current.path);
    link.textContent = "원본 파일 내려받기";
    card.appendChild(link);
  }
  dom.content.appendChild(card);
}

/* -- keyboard, theme, helpers -------------------------------------------- */

function onKeyDown(event) {
  var target = event.target;
  var typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
  if (event.key === "/" && !typing) {
    event.preventDefault();
    dom.filter.focus();
    dom.filter.select();
    return;
  }
  if (event.key === "Escape" && typing) {
    dom.filter.value = "";
    renderFileList();
    dom.filter.blur();
    return;
  }
  if (typing) { return; }
  var presentation = state.payload && state.payload.kind === "presentation";
  if (event.key === "ArrowRight" || event.key === "PageDown") {
    if (presentation) { event.preventDefault(); showSlide(state.slide + 1); }
  } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
    if (presentation) { event.preventDefault(); showSlide(state.slide - 1); }
  } else if (event.key === "j") {
    stepFile(1);
  } else if (event.key === "k") {
    stepFile(-1);
  } else if (event.key === "+" || event.key === "=") {
    if (state.zoomApply) { changeZoom(0.1, state.zoomApply); }
  } else if (event.key === "-") {
    if (state.zoomApply) { changeZoom(-0.1, state.zoomApply); }
  }
}

function stepFile(delta) {
  if (!state.filtered.length) { return; }
  var index = -1;
  if (state.current) {
    state.filtered.forEach(function (item, position) {
      if (item.path === state.current.path) { index = position; }
    });
  }
  var next = Math.min(state.filtered.length - 1, Math.max(0, index + delta));
  if (next !== index || index === -1) {
    openFile(state.filtered[next < 0 ? 0 : next]);
  }
}

function restoreTheme() {
  var stored = null;
  try { stored = localStorage.getItem("docviewer-theme"); } catch (error) { stored = null; }
  if (!stored && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    stored = "dark";
  }
  document.documentElement.setAttribute("data-theme", stored || "light");
}

function toggleTheme() {
  var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("docviewer-theme", next); } catch (error) { /* ignore */ }
}

function toast(message) {
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(function () { dom.toast.hidden = true; }, 3200);
}

function shortenPath(path) {
  var parts = String(path).split("/").filter(Boolean);
  if (path.length <= 46 || parts.length <= 2) { return path; }
  return "…/" + parts.slice(-2).join("/");
}

function formatSize(bytes) {
  if (bytes === null || bytes === undefined) { return ""; }
  var units = ["B", "KB", "MB", "GB"];
  var value = bytes;
  var unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (unit === 0 ? value : value.toFixed(1)) + " " + units[unit];
}

function formatDate(seconds) {
  var date = new Date(seconds * 1000);
  function pad(value) { return String(value).padStart(2, "0"); }
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate())
    + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

function debounce(handler, delay) {
  var timer = null;
  return function () {
    clearTimeout(timer);
    timer = setTimeout(handler, delay);
  };
}
