/* docviewer - phone build.  Opens documents entirely inside the browser:
   docx/xlsx/pptx are unzipped with DecompressionStream and parsed with DOMParser,
   so no server and no libraries are involved. */
"use strict";

var KIND_ICONS = { pdf: "📕", image: "🖼️", document: "📘", spreadsheet: "📗",
                   presentation: "📙", text: "📄" };
var KIND_LABELS = { pdf: "PDF", image: "그림", document: "문서", spreadsheet: "표",
                    presentation: "슬라이드", text: "텍스트" };
var EXTENSIONS = {
  pdf: ["pdf"],
  image: ["png", "jpg", "jpeg", "jfif", "gif", "bmp", "webp", "svg", "ico", "avif"],
  document: ["docx", "docm"],
  spreadsheet: ["xlsx", "xlsm", "csv", "tsv"],
  presentation: ["pptx", "pptm"],
  text: ["txt", "md", "log", "json", "xml", "yml", "yaml", "ini", "cfg", "csv", "tsv",
         "py", "js", "css", "html", "c", "h", "sh", "ngc", "gcode"]
};
var LEGACY = ["doc", "xls", "ppt", "rtf", "odt", "ods", "odp", "hwp"];

var HOST_CHUNK = 512 * 1024;

var state = { files: [], current: null, payload: null, zoom: 1, sheet: 0, slide: 0,
              rotation: 0, fit: true, notes: false, urls: [], loadingHost: false,
              page: 0, pdfOpen: false };
var dom = {};

document.addEventListener("DOMContentLoaded", function () {
  ["main", "title", "back", "pick", "theme", "input"].forEach(function (id) {
    dom[id] = document.getElementById(id);
  });
  restoreTheme();
  installTags();
  dom.pick.addEventListener("click", function () { dom.input.click(); });
  dom.input.addEventListener("change", function () {
    addFiles(Array.prototype.slice.call(dom.input.files));
    dom.input.value = "";
  });
  dom.back.addEventListener("click", showList);
  dom.theme.addEventListener("click", toggleTheme);
  document.addEventListener("dragover", function (event) {
    event.preventDefault();
    var zone = document.querySelector(".drop");
    if (zone) { zone.classList.add("over"); }
  });
  document.addEventListener("dragleave", function () {
    var zone = document.querySelector(".drop");
    if (zone) { zone.classList.remove("over"); }
  });
  document.addEventListener("drop", function (event) {
    event.preventDefault();
    if (event.dataTransfer && event.dataTransfer.files.length) {
      addFiles(Array.prototype.slice.call(event.dataTransfer.files));
    }
  });
  // the app may have handed us a document before the page finished loading; only
  // when it has not do we show the empty home screen
  if (!connectAndroidHost()) {
    showList();
  }
});

function installTags() {
  /* When the page is embedded somewhere else, the document head is not ours, so
     the tags that make "홈 화면에 추가" produce a real app icon are added here. */
  if (document.querySelector("meta[name=\"apple-mobile-web-app-capable\"]")) { return; }
  var icon = window.DOCVIEWER_ICON || "";
  [["apple-mobile-web-app-capable", "yes"], ["mobile-web-app-capable", "yes"],
   ["apple-mobile-web-app-title", "문서 뷰어"], ["theme-color", "#2f6feb"]]
    .forEach(function (pair) {
      var meta = document.createElement("meta");
      meta.name = pair[0];
      meta.content = pair[1];
      document.head.appendChild(meta);
    });
  if (icon) {
    ["apple-touch-icon", "icon"].forEach(function (relation) {
      var link = document.createElement("link");
      link.rel = relation;
      link.href = icon;
      document.head.appendChild(link);
    });
  }
  if (window.DOCVIEWER_MANIFEST) {
    var manifest = document.createElement("link");
    manifest.rel = "manifest";
    manifest.href = window.DOCVIEWER_MANIFEST;
    document.head.appendChild(manifest);
  }
}

/* The android app hands documents over through this bridge: the activity reads
   the incoming content uri, the page pulls the bytes across in chunks.  On the
   web there is no AndroidHost object and none of this runs. */
function connectAndroidHost() {
  var host = window.AndroidHost;
  if (!host) { return false; }
  document.body.classList.add("in-app");
  window.docviewerOpenPending = openHostFiles;
  window.docviewerBack = function () {
    if (state.current) { showList(); return true; }
    return false;
  };
  try { host.ready(); } catch (error) { /* the activity went away */ }
  // the document usually arrived before this page finished loading
  return openHostFiles();
}

/** Pull whatever the app queued for us; returns false when there was nothing. */
function openHostFiles() {
  var host = window.AndroidHost;
  if (!host || state.loadingHost) { return false; }
  var count = 0;
  try { count = host.count(); } catch (error) { return false; }
  if (!count) { return false; }
  state.loadingHost = true;
  dom.main.textContent = "";
  dom.main.appendChild(element("div", "spinner"));
  var files = [];
  var problem = "";
  var problemFile = null;
  try {
    for (var position = 0; position < count; position++) {
      var id = host.id(position);
      var name = host.name(id) || "문서";
      var mime = hostMime(host, id);
      var size = host.size(id);
      if (size < 0) {
        problem = host.error(id) || "파일을 읽지 못했습니다.";
        problemFile = { name: name, size: 0, mime: mime, hostId: id };
        continue;
      }
      var parts = [];
      var received = 0;
      while (received < size) {
        var piece = base64Bytes(host.chunk(id, received, HOST_CHUNK));
        if (!piece.length) {
          break;                     // the activity ran out of data earlier than it said
        }
        parts.push(piece);
        received += piece.length;
      }
      if (received !== size) {
        problem = "파일을 끝까지 읽지 못했습니다 (" + received + " / " + size + " 바이트).";
        problemFile = { name: name, size: size, mime: mime, hostId: id };
        continue;
      }
      var file = new File(parts, name);
      file.hostMime = mime;
      file.hostId = id;
      files.push(file);
    }
  } catch (error) {
    problem = error && error.message ? error.message : String(error);
  } finally {
    // whatever happened, the next document must not find the loader still busy
    state.loadingHost = false;
    try { host.done(); } catch (error) { /* nothing to release */ }
  }
  if (files.length) {
    addFiles(files);
  } else {
    state.current = problemFile;
    renderMessage("파일을 열지 못했습니다", problem || "내용을 읽지 못했습니다.", true);
  }
  return true;
}

function hostMime(host, id) {
  try {
    return host.mime ? host.mime(id) : "";
  } catch (error) {
    return "";
  }
}

/** Some apps hand over a file whose name says nothing; fall back to its type. */
function kindFromMime(mime) {
  mime = (mime || "").toLowerCase();
  if (!mime) { return null; }
  if (mime === "application/pdf") { return "pdf"; }
  if (mime.indexOf("wordprocessingml") >= 0) { return "document"; }
  if (mime.indexOf("spreadsheetml") >= 0) { return "spreadsheet"; }
  if (mime.indexOf("presentationml") >= 0) { return "presentation"; }
  if (mime.indexOf("csv") >= 0 || mime.indexOf("tab-separated") >= 0) { return "spreadsheet"; }
  if (mime.indexOf("image/") === 0) { return "image"; }
  if (mime.indexOf("text/") === 0) { return "text"; }
  return null;
}

function base64Bytes(text) {
  var binary = atob(text || "");
  var bytes = new Uint8Array(binary.length);
  for (var index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function addFiles(files) {
  if (!files.length) { return; }
  state.files = state.files.concat(files);
  if (files.length === 1) { open(files[0]); } else { showList(); }
}

/* ---------------------------------------------------------------- helpers */

function extensionOf(name) {
  var index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}

function kindOf(name) {
  var extension = extensionOf(name);
  for (var kind in EXTENSIONS) {
    if (EXTENSIONS[kind].indexOf(extension) >= 0) {
      if (kind === "text" && (extension === "csv" || extension === "tsv")) {
        return "spreadsheet";
      }
      return kind;
    }
  }
  return null;
}

function escapeHtml(text) {
  return String(text === null || text === undefined ? "" : text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatSize(bytes) {
  var units = ["B", "KB", "MB", "GB"];
  var value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return (unit === 0 ? value : value.toFixed(1)) + " " + units[unit];
}

function element(tag, className, text) {
  var node = document.createElement(tag);
  if (className) { node.className = className; }
  if (text !== undefined) { node.textContent = text; }
  return node;
}

/* ------------------------------------------------------------- zip reader */

function readZip(buffer) {
  var view = new DataView(buffer);
  var end = -1;
  for (var i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) { throw new Error("압축(zip) 구조를 찾지 못했습니다. 파일이 손상되었을 수 있습니다."); }
  var count = view.getUint16(end + 10, true);
  var offset = view.getUint32(end + 16, true);
  if (count === 0xffff || offset === 0xffffffff) {
    var zip64 = readZip64End(view, buffer, end);
    count = zip64.count;
    offset = zip64.offset;
  }
  var entries = {};
  var decoder = new TextDecoder("utf-8");
  var position = offset;
  for (var n = 0; n < count && position + 46 <= buffer.byteLength; n++) {
    if (view.getUint32(position, true) !== 0x02014b50) { break; }
    var nameLength = view.getUint16(position + 28, true);
    var extraLength = view.getUint16(position + 30, true);
    var commentLength = view.getUint16(position + 32, true);
    var name = decoder.decode(new Uint8Array(buffer, position + 46, nameLength));
    var entry = {
      method: view.getUint16(position + 10, true),
      size: view.getUint32(position + 20, true),
      plain: view.getUint32(position + 24, true),
      local: view.getUint32(position + 42, true)
    };
    if (entry.size === 0xffffffff || entry.local === 0xffffffff) {
      readZip64Extra(view, position + 46 + nameLength, extraLength, entry);
    }
    entries[name] = entry;
    position += 46 + nameLength + extraLength + commentLength;
  }
  return { buffer: buffer, view: view, entries: entries };
}

/** Large archives keep the real entry count and directory offset in a zip64 record. */
function readZip64End(view, buffer, end) {
  var locator = end - 20;
  if (locator < 0 || view.getUint32(locator, true) !== 0x07064b50) {
    throw new Error("큰 zip 파일의 목록을 찾지 못했습니다.");
  }
  var record = readUint64(view, locator + 8);
  if (record < 0 || record + 56 > buffer.byteLength
      || view.getUint32(record, true) !== 0x06064b50) {
    throw new Error("큰 zip 파일의 목록을 찾지 못했습니다.");
  }
  return { count: readUint64(view, record + 32), offset: readUint64(view, record + 48) };
}

/** The 0x0001 extra field carries the 64 bit sizes and offset of one entry. */
function readZip64Extra(view, start, length, entry) {
  var position = start;
  var limit = start + length;
  while (position + 4 <= limit) {
    var id = view.getUint16(position, true);
    var size = view.getUint16(position + 2, true);
    if (id === 0x0001) {
      var cursor = position + 4;
      if (entry.plain === 0xffffffff) { entry.plain = readUint64(view, cursor); cursor += 8; }
      if (entry.size === 0xffffffff) { entry.size = readUint64(view, cursor); cursor += 8; }
      if (entry.local === 0xffffffff) { entry.local = readUint64(view, cursor); }
      return;
    }
    position += 4 + size;
  }
}

function readUint64(view, position) {
  var low = view.getUint32(position, true);
  var high = view.getUint32(position + 4, true);
  return high * 4294967296 + low;
}

async function entryBytes(zip, name) {
  var entry = zip.entries[name];
  if (!entry) { return null; }
  var start = entry.local;
  if (zip.view.getUint32(start, true) !== 0x04034b50) {
    throw new Error("압축 파일이 손상되었습니다.");
  }
  var nameLength = zip.view.getUint16(start + 26, true);
  var extraLength = zip.view.getUint16(start + 28, true);
  var from = start + 30 + nameLength + extraLength;
  var data = new Uint8Array(zip.buffer, from, entry.size);
  if (entry.method === 0) { return data; }
  if (entry.method !== 8) { throw new Error("지원하지 않는 압축 방식입니다."); }
  return await inflate(data);
}

async function inflate(data) {
  /* Newer browsers unzip natively; older android webviews have no
     DecompressionStream, so the deflate decoder below takes over. */
  if (typeof DecompressionStream !== "undefined") {
    try {
      var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (error) {
      /* fall through to the decoder below */
    }
  }
  return inflateRaw(data);
}

var LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
                   83, 99, 115, 131, 163, 195, 227, 258];
var LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
                    5, 5, 0];
var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
                 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
                  11, 12, 12, 13, 13];
var CODE_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
var fixedLiteralTree = null;
var fixedDistanceTree = null;

/** Decode a raw deflate stream (RFC 1951). */
function inflateRaw(data) {
  var position = 0, bitBuffer = 0, bitCount = 0;
  var out = new Uint8Array(Math.max(1024, data.length * 4)), length = 0;

  function bits(count) {
    while (bitCount < count) {
      if (position >= data.length) { throw new Error("압축 데이터가 중간에 끊겼습니다."); }
      bitBuffer |= data[position++] << bitCount;
      bitCount += 8;
    }
    var value = bitBuffer & ((1 << count) - 1);
    bitBuffer >>>= count;
    bitCount -= count;
    return value;
  }

  function decode(table) {
    var code = 0, first = 0, index = 0;
    for (var bitLength = 1; bitLength < 16; bitLength++) {
      code |= bits(1);
      var count = table.counts[bitLength];
      if (code - first < count) { return table.symbols[index + (code - first)]; }
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error("압축 데이터가 손상되었습니다.");
  }

  function push(byte) {
    if (length >= out.length) {
      var bigger = new Uint8Array(out.length * 2);
      bigger.set(out);
      out = bigger;
    }
    out[length++] = byte;
  }

  var last;
  do {
    last = bits(1);
    var type = bits(2);
    if (type === 0) {
      bitBuffer = 0;
      bitCount = 0;                                   // stored blocks restart on a byte boundary
      if (position + 4 > data.length) { throw new Error("압축 데이터가 중간에 끊겼습니다."); }
      var stored = data[position] | (data[position + 1] << 8);
      position += 4;
      for (var index = 0; index < stored; index++) { push(data[position++]); }
      continue;
    }
    var literals, distances;
    if (type === 1) {
      literals = fixedTrees()[0];
      distances = fixedTrees()[1];
    } else if (type === 2) {
      var literalCount = bits(5) + 257;
      var distanceCount = bits(5) + 1;
      var codeCount = bits(4) + 4;
      var codeLengths = new Int32Array(19);
      for (var order = 0; order < codeCount; order++) {
        codeLengths[CODE_ORDER[order]] = bits(3);
      }
      var codeTree = huffmanTree(codeLengths);
      var lengths = new Int32Array(literalCount + distanceCount);
      var cursor = 0;
      while (cursor < lengths.length) {
        var symbol = decode(codeTree);
        var repeat;
        if (symbol < 16) {
          lengths[cursor++] = symbol;
        } else if (symbol === 16) {
          repeat = 3 + bits(2);
          while (repeat--) { lengths[cursor] = lengths[cursor - 1]; cursor++; }
        } else if (symbol === 17) {
          repeat = 3 + bits(3);
          while (repeat--) { lengths[cursor++] = 0; }
        } else {
          repeat = 11 + bits(7);
          while (repeat--) { lengths[cursor++] = 0; }
        }
      }
      literals = huffmanTree(lengths.subarray(0, literalCount));
      distances = huffmanTree(lengths.subarray(literalCount));
    } else {
      throw new Error("알 수 없는 압축 블록입니다.");
    }
    for (;;) {
      var value = decode(literals);
      if (value === 256) { break; }
      if (value < 256) {
        push(value);
        continue;
      }
      value -= 257;
      var copy = LENGTH_BASE[value] + bits(LENGTH_EXTRA[value]);
      var distanceSymbol = decode(distances);
      var distance = DIST_BASE[distanceSymbol] + bits(DIST_EXTRA[distanceSymbol]);
      var from = length - distance;
      if (from < 0) { throw new Error("압축 데이터가 손상되었습니다."); }
      for (var step = 0; step < copy; step++) { push(out[from + step]); }
    }
  } while (!last);
  return out.subarray(0, length);
}

function fixedTrees() {
  if (!fixedLiteralTree) {
    var lengths = new Int32Array(288);
    for (var index = 0; index < 288; index++) {
      lengths[index] = index < 144 ? 8 : (index < 256 ? 9 : (index < 280 ? 7 : 8));
    }
    fixedLiteralTree = huffmanTree(lengths);
    var distances = new Int32Array(30);
    for (var slot = 0; slot < 30; slot++) { distances[slot] = 5; }
    fixedDistanceTree = huffmanTree(distances);
  }
  return [fixedLiteralTree, fixedDistanceTree];
}

function huffmanTree(lengths) {
  var counts = new Int32Array(16);
  for (var index = 0; index < lengths.length; index++) { counts[lengths[index]]++; }
  counts[0] = 0;
  var offsets = new Int32Array(16), total = 0;
  for (var bitLength = 1; bitLength < 16; bitLength++) {
    offsets[bitLength] = total;
    total += counts[bitLength];
  }
  var symbols = new Int32Array(total);
  for (var symbol = 0; symbol < lengths.length; symbol++) {
    if (lengths[symbol]) { symbols[offsets[lengths[symbol]]++] = symbol; }
  }
  return { counts: counts, symbols: symbols };
}

async function entryText(zip, name) {
  var bytes = await entryBytes(zip, name);
  return bytes === null ? null : new TextDecoder("utf-8").decode(bytes);
}

async function entryXml(zip, name) {
  var text = await entryText(zip, name);
  if (text === null) { return null; }
  var parsed = new DOMParser().parseFromString(text, "application/xml");
  if (parsed.getElementsByTagName("parsererror").length) {
    throw new Error("문서 안의 XML을 읽지 못했습니다.");
  }
  return parsed;
}

function mediaUrl(zip, part) {
  if (!zip.media) { zip.media = {}; }
  if (zip.media[part]) { return zip.media[part]; }
  var entry = zip.entries[part];
  if (!entry) { return ""; }
  var promise = entryBytes(zip, part).then(function (bytes) {
    var extension = extensionOf(part);
    var types = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
                  bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml",
                  tif: "image/tiff", tiff: "image/tiff" };
    var url = URL.createObjectURL(new Blob([bytes], { type: types[extension] || "image/png" }));
    state.urls.push(url);
    return url;
  });
  zip.media[part] = promise;
  return promise;
}

/* --------------------------------------------------------------- xml util */

function children(node, name) {
  var out = [];
  if (!node) { return out; }
  for (var child = node.firstElementChild; child; child = child.nextElementSibling) {
    if (!name || child.localName === name) { out.push(child); }
  }
  return out;
}

function child(node, name) {
  var found = children(node, name);
  return found.length ? found[0] : null;
}

function descendants(node, name) {
  if (!node) { return []; }
  var out = [];
  var all = node.getElementsByTagName("*");
  for (var i = 0; i < all.length; i++) {
    if (all[i].localName === name) { out.push(all[i]); }
  }
  return out;
}

function attribute(node, name) {
  if (!node || !node.attributes) { return null; }
  for (var i = 0; i < node.attributes.length; i++) {
    if (node.attributes[i].localName === name) { return node.attributes[i].value; }
  }
  return null;
}

function value(node) { return attribute(node, "val"); }

var RELATIONSHIP_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/* r:id and r:embed must be looked up by namespace: p:sldId carries a plain
   "id" attribute as well, and matching on the local name alone finds that one. */
function relationshipId(node) {
  if (!node || !node.attributes) { return null; }
  for (var i = 0; i < node.attributes.length; i++) {
    var candidate = node.attributes[i];
    if (candidate.namespaceURI === RELATIONSHIP_NS
        && (candidate.localName === "id" || candidate.localName === "embed"
            || candidate.localName === "link")) {
      return candidate.value;
    }
  }
  return null;
}

function textOf(node, tag) {
  return descendants(node, tag).map(function (item) { return item.textContent || ""; }).join("");
}

function toNumber(text, fallback) {
  var parsed = parseFloat(text);
  return isNaN(parsed) ? fallback : parsed;
}

function normalizePath(base, target) {
  if (/^[a-z]+:/i.test(target)) { return target; }
  if (target.charAt(0) === "/") { return target.slice(1); }
  var parts = base.split("/").slice(0, -1).concat(target.split("/"));
  var stack = [];
  parts.forEach(function (part) {
    if (part === "." || part === "") { return; }
    if (part === "..") { stack.pop(); } else { stack.push(part); }
  });
  return stack.join("/");
}

async function relationships(zip, part) {
  var slash = part.lastIndexOf("/");
  var name = part.slice(0, slash + 1) + "_rels/" + part.slice(slash + 1) + ".rels";
  var document_ = await entryXml(zip, name);
  var result = {};
  if (!document_) { return result; }
  children(document_.documentElement, "Relationship").forEach(function (node) {
    var target = node.getAttribute("Target") || "";
    var mode = node.getAttribute("TargetMode") || "Internal";
    result[node.getAttribute("Id")] = {
      target: mode === "External" ? target : normalizePath(part, target),
      mode: mode,
      type: node.getAttribute("Type") || ""
    };
  });
  return result;
}

async function coreProperties(zip) {
  var document_ = await entryXml(zip, "docProps/core.xml");
  if (!document_) { return {}; }
  var labels = { title: "제목", creator: "작성자", lastModifiedBy: "최종 수정자",
                 created: "만든 날짜", modified: "수정한 날짜", subject: "주제" };
  var properties = {};
  children(document_.documentElement).forEach(function (node) {
    var label = labels[node.localName];
    if (label && (node.textContent || "").trim()) {
      properties[label] = node.textContent.trim();
    }
  });
  return properties;
}

/* ------------------------------------------------------------------ .docx */

var HEADINGS = { title: "h1", subtitle: "h2", heading1: "h1", heading2: "h2", heading3: "h3",
                 heading4: "h4", heading5: "h5", heading6: "h6" };
var ALIGNMENTS = { left: "left", start: "left", center: "center", right: "right", end: "right",
                   both: "justify", distribute: "justify" };

async function parseDocx(zip) {
  var document_ = await entryXml(zip, "word/document.xml");
  if (!document_) { throw new Error("워드 문서 구조를 찾지 못했습니다."); }
  var context = {
    zip: zip,
    rels: await relationships(zip, "word/document.xml"),
    numbering: await readNumbering(zip),
    lists: []
  };
  var out = [];
  await renderBlocks(child(document_.documentElement, "body"), context, out);
  closeLists(context, 0, out);
  return { kind: "document", html: out.join(""), properties: await coreProperties(zip) };
}

async function readNumbering(zip) {
  var document_ = await entryXml(zip, "word/numbering.xml");
  var result = {};
  if (!document_) { return result; }
  var abstract = {};
  children(document_.documentElement, "abstractNum").forEach(function (node) {
    var id = attribute(node, "abstractNumId");
    children(node, "lvl").forEach(function (level) {
      var index = parseInt(attribute(level, "ilvl") || "0", 10) || 0;
      var format = value(child(level, "numFmt")) || "decimal";
      abstract[id + ":" + index] = format !== "bullet" && format !== "none";
    });
  });
  children(document_.documentElement, "num").forEach(function (node) {
    var id = attribute(node, "numId");
    var abstractId = value(child(node, "abstractNumId"));
    for (var key in abstract) {
      var parts = key.split(":");
      if (parts[0] === abstractId) { result[id + ":" + parts[1]] = abstract[key]; }
    }
  });
  return result;
}

async function renderBlocks(container, context, out) {
  var nodes = children(container);
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (node.localName === "p") {
      await renderParagraph(node, context, out);
    } else if (node.localName === "tbl") {
      closeLists(context, 0, out);
      await renderTable(node, context, out);
    } else if (node.localName === "sdt") {
      await renderBlocks(child(node, "sdtContent"), context, out);
    }
  }
}

async function renderParagraph(paragraph, context, out) {
  var properties = child(paragraph, "pPr");
  var listInfo = listInfoOf(properties, context);
  var inline = await renderRuns(paragraph, context);
  if (listInfo) {
    openLists(listInfo, context, out);
    out.push("<li>" + (inline || "") + "</li>");
    return;
  }
  closeLists(context, 0, out);
  if (!inline.replace(/<[^>]*>/g, "").trim() && inline.indexOf("<img") < 0) {
    out.push("<p class=\"empty\"></p>");
    return;
  }
  var style = (value(child(properties, "pStyle")) || "").replace(/[\s-]/g, "").toLowerCase();
  var tag = HEADINGS[style] || "p";
  var css = [];
  var alignment = ALIGNMENTS[value(child(properties, "jc")) || ""];
  if (alignment) { css.push("text-align:" + alignment); }
  var attributes = css.length ? " style=\"" + escapeHtml(css.join(";")) + "\"" : "";
  out.push("<" + tag + attributes + ">" + inline + "</" + tag + ">");
}

function listInfoOf(properties, context) {
  var numbering = child(properties, "numPr");
  if (!numbering) { return null; }
  var id = value(child(numbering, "numId"));
  if (!id || id === "0") { return null; }
  var level = Math.max(0, Math.min(parseInt(value(child(numbering, "ilvl")) || "0", 10) || 0, 8));
  var ordered = context.numbering[id + ":" + level];
  return { level: level, ordered: ordered === undefined ? true : ordered };
}

function openLists(info, context, out) {
  closeLists(context, info.level + 1, out);
  var tag = info.ordered ? "ol" : "ul";
  while (context.lists.length <= info.level) {
    context.lists.push(tag);
    out.push("<" + tag + ">");
  }
}

function closeLists(context, depth, out) {
  while (context.lists.length > depth) { out.push("</" + context.lists.pop() + ">"); }
}

async function renderTable(table, context, out) {
  out.push("<div class=\"table-wrap\"><table class=\"doc-table\">");
  var owners = {};
  var cells = [];
  var rows = children(table, "tr");
  for (var r = 0; r < rows.length; r++) {
    out.push("<tr>");
    var column = 0;
    var cellNodes = children(rows[r], "tc");
    for (var c = 0; c < cellNodes.length; c++) {
      var properties = child(cellNodes[c], "tcPr");
      var span = Math.max(1, parseInt(value(child(properties, "gridSpan")) || "1", 10) || 1);
      var mergeNode = child(properties, "vMerge");
      var merge = mergeNode ? (value(mergeNode) || "continue") : null;
      if (merge === "continue" && owners[column]) {
        owners[column].rows += 1;
        column += span;
        continue;
      }
      var content = [];
      await renderBlocks(cellNodes[c], context, content);
      closeLists(context, 0, content);
      var info = { index: out.length, span: span, rows: 1 };
      cells.push(info);
      out.push("");
      out.push(content.join("") || "&nbsp;");
      out.push("</td>");
      if (merge === "restart") { owners[column] = info; } else { delete owners[column]; }
      column += span;
    }
    out.push("</tr>");
  }
  cells.forEach(function (info) {
    var attributes = (info.span > 1 ? " colspan=\"" + info.span + "\"" : "")
      + (info.rows > 1 ? " rowspan=\"" + info.rows + "\"" : "");
    out[info.index] = "<td" + attributes + ">";
  });
  out.push("</table></div>");
}

async function renderRuns(container, context) {
  var parts = [];
  var nodes = children(container);
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (node.localName === "r") {
      parts.push(await renderRun(node, context));
    } else if (node.localName === "hyperlink") {
      var inner = await renderRuns(node, context);
      var target = context.rels[relationshipId(node)];
      if (target && target.mode === "External") {
        parts.push("<a href=\"" + escapeHtml(target.target)
          + "\" target=\"_blank\" rel=\"noopener\">" + inner + "</a>");
      } else {
        parts.push(inner);
      }
    } else if (node.localName === "sdt") {
      parts.push(await renderRuns(child(node, "sdtContent"), context));
    } else if (node.localName === "ins") {
      parts.push(await renderRuns(node, context));
    }
  }
  return parts.join("");
}

async function renderRun(run, context) {
  var pieces = [];
  var nodes = children(run);
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (node.localName === "t") {
      pieces.push(escapeHtml(node.textContent || ""));
    } else if (node.localName === "tab") {
      pieces.push("<span class=\"tab\"></span>");
    } else if (node.localName === "br" || node.localName === "cr") {
      pieces.push("<br>");
    } else if (node.localName === "drawing" || node.localName === "pict") {
      pieces.push(await renderDrawing(node, context));
    }
  }
  var text = pieces.join("");
  if (!text) { return ""; }
  var properties = child(run, "rPr");
  if (!properties) { return text; }
  if (flag(properties, "b")) { text = "<strong>" + text + "</strong>"; }
  if (flag(properties, "i")) { text = "<em>" + text + "</em>"; }
  if (flag(properties, "u")) { text = "<u>" + text + "</u>"; }
  if (flag(properties, "strike")) { text = "<s>" + text + "</s>"; }
  var vertical = value(child(properties, "vertAlign"));
  if (vertical === "superscript") { text = "<sup>" + text + "</sup>"; }
  if (vertical === "subscript") { text = "<sub>" + text + "</sub>"; }
  var css = [];
  var color = value(child(properties, "color"));
  if (color && color !== "auto" && color !== "000000") { css.push("color:#" + color); }
  var highlight = value(child(properties, "highlight"));
  if (highlight && highlight !== "none") { css.push("background-color:" + highlight); }
  if (css.length) {
    text = "<span style=\"" + escapeHtml(css.join(";")) + "\">" + text + "</span>";
  }
  return text;
}

function flag(properties, name) {
  var node = child(properties, name);
  if (!node) { return false; }
  var raw = value(node);
  return raw !== "0" && raw !== "false" && raw !== "none" && raw !== "off";
}

async function renderDrawing(node, context) {
  var blips = descendants(node, "blip");
  var id = blips.length ? relationshipId(blips[0]) : null;
  if (!id) {
    var vml = descendants(node, "imagedata");
    id = vml.length ? relationshipId(vml[0]) : null;
  }
  var relation = id ? context.rels[id] : null;
  if (!relation) { return ""; }
  var url = await mediaUrl(context.zip, relation.target);
  if (!url) { return ""; }
  var extents = descendants(node, "ext");
  var width = "";
  if (extents.length) {
    var pixels = toNumber(attribute(extents[0], "cx"), 0) / 9525;
    if (pixels > 0) { width = " style=\"width:" + Math.round(pixels) + "px\""; }
  }
  return "<img src=\"" + escapeHtml(url) + "\" alt=\"\"" + width + ">";
}

/* ------------------------------------------------------------------ .xlsx */

var BUILTIN_DATES = [14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47];
var EPOCH = Date.UTC(1899, 11, 30);

async function parseXlsx(zip) {
  var workbook = await entryXml(zip, "xl/workbook.xml");
  if (!workbook) { throw new Error("엑셀 문서 구조를 찾지 못했습니다."); }
  var rels = await relationships(zip, "xl/workbook.xml");
  var shared = await readSharedStrings(zip);
  var styles = await readStyles(zip);
  var sheets = [];
  var nodes = children(child(workbook.documentElement, "sheets"), "sheet");
  for (var i = 0; i < nodes.length; i++) {
    if (attribute(nodes[i], "state") === "hidden") { continue; }
    var relation = rels[relationshipId(nodes[i])];
    if (!relation) { continue; }
    sheets.push(await readSheet(zip, relation.target, attribute(nodes[i], "name") || "시트",
                                shared, styles));
  }
  if (!sheets.length) { throw new Error("표시할 시트가 없습니다."); }
  return { kind: "spreadsheet", sheets: sheets, properties: await coreProperties(zip) };
}

async function readSharedStrings(zip) {
  var document_ = await entryXml(zip, "xl/sharedStrings.xml");
  if (!document_) { return []; }
  return children(document_.documentElement, "si").map(function (item) {
    return textOf(item, "t");
  });
}

async function readStyles(zip) {
  var document_ = await entryXml(zip, "xl/styles.xml");
  if (!document_) { return []; }
  var custom = {};
  children(child(document_.documentElement, "numFmts"), "numFmt").forEach(function (node) {
    custom[attribute(node, "numFmtId")] = attribute(node, "formatCode") || "";
  });
  return children(child(document_.documentElement, "cellXfs"), "xf").map(function (node) {
    var id = attribute(node, "numFmtId") || "0";
    if (custom[id] !== undefined) { return classifyFormat(custom[id]); }
    return BUILTIN_DATES.indexOf(parseInt(id, 10)) >= 0 ? "date" : null;
  });
}

function classifyFormat(code) {
  var stripped = (code || "").replace(/\\./g, "").replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "");
  var hasDate = /[yd]/i.test(stripped);
  var hasTime = /[hs]/i.test(stripped);
  if (hasDate && hasTime) { return "datetime"; }
  if (hasDate) { return "date"; }
  if (hasTime) { return "time"; }
  if (stripped.indexOf("%") >= 0) { return "percent"; }
  return null;
}

async function readSheet(zip, part, name, shared, styles) {
  var document_ = await entryXml(zip, part);
  var rows = [];
  var width = 0;
  children(child(document_.documentElement, "sheetData"), "row").forEach(function (rowNode) {
    if (rows.length >= 2000) { return; }
    var index = parseInt(attribute(rowNode, "r") || String(rows.length + 1), 10);
    while (rows.length < index - 1 && rows.length < 2000) { rows.push([]); }
    var cells = [];
    children(rowNode, "c").forEach(function (cellNode) {
      var column = columnIndex(attribute(cellNode, "r"), cells.length);
      if (column >= 120) { return; }
      while (cells.length < column) { cells.push(null); }
      cells.push(readCell(cellNode, shared, styles));
    });
    width = Math.max(width, cells.length);
    rows.push(cells);
  });
  rows.forEach(function (row) { while (row.length < width) { row.push(null); } });
  while (rows.length && !rows[rows.length - 1].some(Boolean)) { rows.pop(); }
  var merges = [];
  children(child(document_.documentElement, "mergeCells"), "mergeCell").forEach(function (node) {
    var reference = (attribute(node, "ref") || "").split(":");
    if (reference.length !== 2) { return; }
    var firstRow = rowIndex(reference[0]), lastRow = rowIndex(reference[1]);
    var firstColumn = columnIndex(reference[0], 0), lastColumn = columnIndex(reference[1], 0);
    merges.push({ r: firstRow - 1, c: firstColumn, rs: lastRow - firstRow + 1,
                  cs: lastColumn - firstColumn + 1 });
  });
  return { name: name, rows: rows, merges: merges };
}

function readCell(node, shared, styles) {
  var type = attribute(node, "t") || "n";
  if (type === "inlineStr") {
    var text = textOf(child(node, "is"), "t");
    return text ? { v: text } : null;
  }
  var valueNode = child(node, "v");
  if (!valueNode || valueNode.textContent === "") { return null; }
  var raw = valueNode.textContent;
  if (type === "s") {
    var index = parseInt(raw, 10);
    return shared[index] ? { v: shared[index] } : null;
  }
  if (type === "b") { return { v: raw === "0" ? "FALSE" : "TRUE" }; }
  if (type === "e") { return { v: raw, e: true }; }
  if (type === "str" || type === "d") { return { v: raw }; }
  var number = parseFloat(raw);
  if (isNaN(number)) { return { v: raw }; }
  var style = styles[parseInt(attribute(node, "s") || "-1", 10)];
  if (style === "date" || style === "datetime" || style === "time") {
    var formatted = formatSerial(number, style);
    if (formatted) { return { v: formatted, n: true }; }
  }
  if (style === "percent") { return { v: formatNumber(number * 100) + "%", n: true }; }
  return { v: formatNumber(number), n: true };
}

function formatSerial(serial, style) {
  if (serial < 0 || serial > 2958466) { return null; }
  var moment = new Date(EPOCH + (serial + (serial < 60 ? 1 : 0)) * 86400000);
  function pad(number) { return String(number).padStart(2, "0"); }
  var date = moment.getUTCFullYear() + "-" + pad(moment.getUTCMonth() + 1) + "-"
    + pad(moment.getUTCDate());
  var time = pad(moment.getUTCHours()) + ":" + pad(moment.getUTCMinutes()) + ":"
    + pad(moment.getUTCSeconds());
  if (style === "time") { return time; }
  if (style === "datetime") { return date + " " + time; }
  return date;
}

function formatNumber(number) {
  if (number === Math.round(number) && Math.abs(number) < 1e15) { return String(number); }
  return String(parseFloat(number.toPrecision(10)));
}

function columnIndex(reference, fallback) {
  if (!reference) { return fallback; }
  var index = 0;
  for (var i = 0; i < reference.length; i++) {
    var code = reference.toUpperCase().charCodeAt(i);
    if (code < 65 || code > 90) { break; }
    index = index * 26 + (code - 64);
  }
  return index ? index - 1 : fallback;
}

function rowIndex(reference) {
  var digits = (reference || "").replace(/\D/g, "");
  return digits ? parseInt(digits, 10) : 1;
}

function columnName(index) {
  var name = "";
  index += 1;
  while (index > 0) {
    name = String.fromCharCode(65 + ((index - 1) % 26)) + name;
    index = Math.floor((index - 1) / 26);
  }
  return name;
}

/* ------------------------------------------------------------------ .pptx */

async function parsePptx(zip) {
  var presentation = await entryXml(zip, "ppt/presentation.xml");
  if (!presentation) { throw new Error("파워포인트 문서 구조를 찾지 못했습니다."); }
  var size = child(presentation.documentElement, "sldSz");
  var width = Math.round(toNumber(attribute(size, "cx"), 9144000) / 9525);
  var height = Math.round(toNumber(attribute(size, "cy"), 5143500) / 9525);
  var rels = await relationships(zip, "ppt/presentation.xml");
  var slides = [];
  var ids = children(child(presentation.documentElement, "sldIdLst"), "sldId");
  for (var i = 0; i < ids.length; i++) {
    var relation = rels[relationshipId(ids[i])];
    if (!relation) { continue; }
    slides.push(await readSlide(zip, relation.target, slides.length + 1));
  }
  if (!slides.length) { throw new Error("표시할 슬라이드가 없습니다."); }
  return { kind: "presentation", width: width, height: height, slides: slides,
           properties: await coreProperties(zip) };
}

async function readSlide(zip, part, number) {
  var document_ = await entryXml(zip, part);
  var rels = await relationships(zip, part);
  var tree = child(child(document_.documentElement, "cSld"), "spTree");
  var shapes = [];
  await collectShapes(zip, tree, rels, shapes);
  var notes = "";
  for (var id in rels) {
    if (rels[id].type.indexOf("/notesSlide") >= 0) {
      var notesDocument = await entryXml(zip, rels[id].target);
      if (notesDocument) {
        notes = descendants(notesDocument.documentElement, "p").map(function (paragraph) {
          return textOf(paragraph, "t");
        }).filter(function (line) { return line.trim(); }).join("\n");
      }
    }
  }
  var title = "";
  shapes.some(function (shape) {
    if (shape.kind !== "text") { return false; }
    var plain = shape.html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (plain) { title = plain.slice(0, 60); return true; }
    return false;
  });
  return { number: number, shapes: shapes, notes: notes, title: title };
}

async function collectShapes(zip, container, rels, shapes) {
  var nodes = children(container);
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (node.localName === "sp") {
      var body = child(node, "txBody");
      var html = body ? renderTextBody(body) : "";
      if (html.replace(/<[^>]*>/g, "").trim()) {
        shapes.push(Object.assign(geometry(child(node, "spPr")), { kind: "text", html: html }));
      }
    } else if (node.localName === "pic") {
      var blips = descendants(node, "blip");
      var relation = blips.length ? rels[relationshipId(blips[0])] : null;
      if (relation) {
        var url = await mediaUrl(zip, relation.target);
        shapes.push(Object.assign(geometry(child(node, "spPr")), { kind: "image", src: url }));
      }
    } else if (node.localName === "graphicFrame") {
      var tables = descendants(node, "tbl");
      if (tables.length) {
        var html = ["<table>"];
        children(tables[0], "tr").forEach(function (row) {
          html.push("<tr>");
          children(row, "tc").forEach(function (cell) {
            html.push("<td>" + (renderTextBody(child(cell, "txBody")) || "&nbsp;") + "</td>");
          });
          html.push("</tr>");
        });
        html.push("</table>");
        shapes.push(Object.assign(geometry(child(node, "xfrm")),
                                  { kind: "text", html: html.join("") }));
      }
    } else if (node.localName === "grpSp") {
      await collectShapes(zip, node, rels, shapes);
    }
  }
}

function renderTextBody(body) {
  if (!body) { return ""; }
  return children(body, "p").map(function (paragraph) {
    var properties = child(paragraph, "pPr");
    var css = [];
    var alignment = { l: "left", ctr: "center", r: "right", just: "justify" }[
      attribute(properties, "algn") || ""];
    if (alignment) { css.push("text-align:" + alignment); }
    var level = parseInt(attribute(properties, "lvl") || "0", 10) || 0;
    var bullet = properties && !child(properties, "buNone")
      && (child(properties, "buChar") || child(properties, "buAutoNum"));
    if (level || bullet) { css.push("margin-left:" + (level * 22 + (bullet ? 14 : 0)) + "px"); }
    var text = children(paragraph).map(function (run) {
      if (run.localName === "br") { return "<br>"; }
      if (run.localName !== "r" && run.localName !== "fld") { return ""; }
      var content = escapeHtml(textOf(run, "t"));
      if (!content) { return ""; }
      var properties_ = child(run, "rPr");
      if (!properties_) { return content; }
      var style = [];
      var size = attribute(properties_, "sz");
      if (size) { style.push("font-size:" + (toNumber(size, 1800) / 100 * 96 / 72).toFixed(1) + "px"); }
      var fill = child(properties_, "solidFill");
      var color = fill ? child(fill, "srgbClr") : null;
      if (color && attribute(color, "val")) { style.push("color:#" + attribute(color, "val")); }
      if (attribute(properties_, "b") === "1") { content = "<strong>" + content + "</strong>"; }
      if (attribute(properties_, "i") === "1") { content = "<em>" + content + "</em>"; }
      var underline = attribute(properties_, "u");
      if (underline && underline !== "none") { content = "<u>" + content + "</u>"; }
      if (style.length) {
        content = "<span style=\"" + escapeHtml(style.join(";")) + "\">" + content + "</span>";
      }
      return content;
    }).join("");
    return "<p class=\"" + (bullet ? "bullet" : "") + "\""
      + (css.length ? " style=\"" + escapeHtml(css.join(";")) + "\"" : "") + ">"
      + (text || "<br>") + "</p>";
  }).join("");
}

function geometry(properties) {
  var xfrm = properties
    && (properties.localName === "xfrm" ? properties : child(properties, "xfrm"));
  if (!xfrm) { return { x: null, y: null, w: null, h: null }; }
  var offset = child(xfrm, "off");
  var extent = child(xfrm, "ext");
  if (!offset || !extent) { return { x: null, y: null, w: null, h: null }; }
  return { x: toNumber(attribute(offset, "x"), 0) / 9525,
           y: toNumber(attribute(offset, "y"), 0) / 9525,
           w: toNumber(attribute(extent, "cx"), 0) / 9525,
           h: toNumber(attribute(extent, "cy"), 0) / 9525,
           rot: toNumber(attribute(xfrm, "rot"), 0) / 60000 };
}

/* ------------------------------------------------------------ text & csv */

function decodeText(buffer) {
  var bytes = new Uint8Array(buffer);
  try {
    var text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch (error) {
    try {
      return new TextDecoder("euc-kr").decode(bytes);
    } catch (fallbackError) {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

function parseCsv(text, delimiter) {
  if (!delimiter) {
    var head = text.split("\n").slice(0, 20).join("\n");
    delimiter = (head.split("\t").length > head.split(",").length) ? "\t" : ",";
  }
  var rows = [[]];
  var field = "";
  var quoted = false;
  for (var i = 0; i < text.length; i++) {
    var character = text.charAt(i);
    if (quoted) {
      if (character === "\"") {
        if (text.charAt(i + 1) === "\"") { field += "\""; i += 1; } else { quoted = false; }
      } else { field += character; }
    } else if (character === "\"") {
      quoted = true;
    } else if (character === delimiter) {
      rows[rows.length - 1].push(field); field = "";
    } else if (character === "\n") {
      rows[rows.length - 1].push(field); field = ""; rows.push([]);
    } else if (character !== "\r") {
      field += character;
    }
  }
  rows[rows.length - 1].push(field);
  while (rows.length && rows[rows.length - 1].every(function (cell) { return !cell; })) {
    rows.pop();
  }
  var width = 0;
  rows.forEach(function (row) { width = Math.max(width, row.length); });
  var cells = rows.slice(0, 2000).map(function (row) {
    var out = row.map(function (raw) {
      var trimmed = (raw || "").trim();
      if (!trimmed) { return null; }
      return isFinite(trimmed.replace(/,/g, "")) && trimmed !== "" ? { v: trimmed, n: true }
                                                                   : { v: trimmed };
    });
    while (out.length < width) { out.push(null); }
    return out;
  });
  return { kind: "spreadsheet", sheets: [{ name: "CSV", rows: cells, merges: [] }],
           properties: {} };
}

/* ------------------------------------------------------------------- open */

async function open(file) {
  state.current = file;
  state.payload = null;
  state.zoom = 1;
  state.sheet = 0;
  state.slide = 0;
  state.rotation = 0;
  state.fit = true;
  state.notes = false;
  dom.title.textContent = file.name;
  dom.back.hidden = state.files.length < 2 && !state.files.length;
  dom.back.hidden = false;
  dom.main.textContent = "";
  dom.main.appendChild(element("div", "spinner"));
  releasePdf();
  var kind = kindOf(file.name) || kindFromMime(file.hostMime || file.type);
  try {
    var payload;
    if (kind === "pdf") {
      payload = openPdf(file);
    } else if (kind === "image") {
      payload = { kind: kind, url: objectUrl(file) };
    } else if (kind === "text") {
      payload = { kind: "text", text: decodeText(await file.arrayBuffer()) };
    } else if (kind === "spreadsheet" && /csv|tsv$/.test(extensionOf(file.name))) {
      payload = parseCsv(decodeText(await file.arrayBuffer()),
                         extensionOf(file.name) === "tsv" ? "\t" : null);
    } else if (kind === "document" || kind === "spreadsheet" || kind === "presentation") {
      var zip = readZip(await file.arrayBuffer());
      payload = kind === "document" ? await parseDocx(zip)
        : (kind === "spreadsheet" ? await parseXlsx(zip) : await parsePptx(zip));
    } else if (LEGACY.indexOf(extensionOf(file.name)) >= 0) {
      payload = { kind: "unsupported", message: "." + extensionOf(file.name)
        + " 는 오래된 형식이라 휴대폰에서 바로 열 수 없습니다. 워드/엑셀/파워포인트에서 "
        + "docx · xlsx · pptx 로 저장한 뒤 다시 열어 주세요." };
    } else {
      payload = { kind: "unsupported", message: "지원하지 않는 형식입니다." };
    }
    state.payload = payload;
    renderPayload(payload);
  } catch (error) {
    state.payload = null;
    renderMessage("파일을 열지 못했습니다", error.message || String(error), true);
  }
}

/** Android's WebView cannot display a pdf, so the app renders the pages for us. */
function openPdf(file) {
  var host = window.AndroidHost;
  if (host && host.pdfOpen && file.hostId) {
    var pages = 0;
    try { pages = host.pdfOpen(file.hostId); } catch (error) { pages = -1; }
    if (pages > 0) {
      state.pdfOpen = true;
      return { kind: "pdf", pages: pages, hostId: file.hostId };
    }
    return { kind: "unsupported", hostId: file.hostId,
             message: "이 PDF 를 그리지 못했습니다. 암호가 걸려 있거나 형식이 특이한 파일일 수 "
                      + "있습니다. 아래 단추로 다른 앱에서 열어 보세요." };
  }
  return { kind: "pdf", url: objectUrl(file) };
}

function releasePdf() {
  if (!state.pdfOpen) { return; }
  state.pdfOpen = false;
  try {
    if (window.AndroidHost && window.AndroidHost.pdfClose) { window.AndroidHost.pdfClose(); }
  } catch (error) { /* the app went away */ }
}

function objectUrl(file) {
  var url = URL.createObjectURL(file);
  state.urls.push(url);
  return url;
}

/* --------------------------------------------------------------------- ui */

function showList() {
  releasePdf();
  state.current = null;
  state.payload = null;
  dom.title.textContent = "📄 문서 뷰어";
  dom.back.hidden = true;
  dom.main.textContent = "";
  if (!state.files.length) {
    var intro = element("div", "intro");
    var logo = document.createElement("img");
    logo.className = "logo";
    logo.src = window.DOCVIEWER_ICON || "/static/icon-180.png";
    logo.alt = "";
    intro.appendChild(logo);
    intro.appendChild(element("h2", null, "문서 뷰어"));
    intro.appendChild(element("p", null,
      "PDF · 워드 · 엑셀 · 파워포인트 · 그림 파일을 이 화면에서 바로 봅니다."));
    intro.appendChild(element("p", null, "파일은 휴대폰 밖으로 전송되지 않습니다."));
    dom.main.appendChild(intro);

    var drop = element("div", "drop");
    var button = element("button", "primary", "휴대폰에서 파일 고르기");
    button.addEventListener("click", function () { dom.input.click(); });
    drop.appendChild(button);
    drop.appendChild(element("p", null, "또는 파일을 이 영역으로 끌어다 놓으세요"));
    var formats = element("div", "formats");
    ["PDF", "DOCX", "XLSX", "PPTX", "PNG · JPG", "CSV", "TXT"].forEach(function (name) {
      formats.appendChild(element("span", "chip", name));
    });
    drop.appendChild(formats);
    dom.main.appendChild(drop);

    var tip = element("div", "tip");
    if (window.AndroidHost) {
      tip.innerHTML = "<b>다운로드한 파일 바로 열기</b><br>"
        + "파일 앱이나 다운로드 목록에서 문서를 누른 뒤 <b>문서 뷰어</b>를 고르면 "
        + "바로 이 화면에 열립니다. 다른 앱의 <b>공유</b> 메뉴에서도 보낼 수 있습니다.";
    } else {
      tip.innerHTML = "<b>홈 화면에 추가하기</b><br>"
        + "아이폰: 사파리 아래 <b>공유</b> → <b>홈 화면에 추가</b><br>"
        + "안드로이드: 크롬 오른쪽 위 <b>⋮</b> → <b>홈 화면에 추가</b><br>"
        + "추가하면 앱처럼 아이콘으로 실행되고, 인터넷 없이도 열립니다.";
    }
    dom.main.appendChild(tip);
    return;
  }
  var list = element("ul", "list");
  state.files.forEach(function (file) {
    var item = document.createElement("li");
    var kind = kindOf(file.name);
    var button = document.createElement("button");
    button.appendChild(element("span", "emoji", KIND_ICONS[kind] || "📄"));
    var name = element("span", "name", file.name);
    button.appendChild(name);
    button.appendChild(element("span", "size", formatSize(file.size)));
    button.addEventListener("click", function () { open(file); });
    item.appendChild(button);
    list.appendChild(item);
  });
  dom.main.appendChild(list);
  var more = element("div", "pad");
  var add = element("button", "primary", "파일 더 열기");
  add.addEventListener("click", function () { dom.input.click(); });
  more.appendChild(add);
  dom.main.appendChild(more);
}

function renderPayload(payload) {
  dom.main.textContent = "";
  var toolbar = element("div", "toolbar");
  dom.main.appendChild(toolbar);
  var body = element("div");
  dom.main.appendChild(body);
  var renderers = { pdf: renderPdf, image: renderImage, document: renderDocument,
                    spreadsheet: renderSpreadsheet, presentation: renderPresentation,
                    text: renderText };
  var renderer = renderers[payload.kind];
  if (!renderer) {
    renderMessage("이 형식은 열 수 없습니다", payload.message || "", false);
    return;
  }
  renderer(payload, body, toolbar);
  if (payload.properties && Object.keys(payload.properties).length) {
    var properties = element("div", "props");
    Object.keys(payload.properties).forEach(function (key) {
      properties.appendChild(element("span", null, key + ": " + payload.properties[key]));
    });
    dom.main.appendChild(properties);
  }
}

function addButton(toolbar, label, handler, pressed) {
  var button = element("button", null, label);
  if (pressed !== undefined) { button.setAttribute("aria-pressed", String(pressed)); }
  button.addEventListener("click", handler);
  toolbar.appendChild(button);
  return button;
}

function addZoom(toolbar, apply) {
  var label = element("span", "zoom", "100%");
  addButton(toolbar, "−", function () { step(-0.1); });
  toolbar.appendChild(label);
  addButton(toolbar, "＋", function () { step(0.1); });
  function step(delta) {
    state.zoom = Math.min(4, Math.max(0.4, Math.round((state.zoom + delta) * 100) / 100));
    label.textContent = Math.round(state.zoom * 100) + "%";
    apply();
  }
  return label;
}

function addShare(toolbar, url, name) {
  addButton(toolbar, "↗ 새 탭", function () {
    window.open(url, "_blank", "noopener");
  });
}

function renderPdf(payload, body, toolbar) {
  if (payload.pages) {
    renderPdfPages(payload, body, toolbar);
    return;
  }
  addShare(toolbar, payload.url, state.current.name);
  var note = element("div", "warn",
    "휴대폰 브라우저에 따라 아래 미리보기가 비어 보일 수 있습니다. 그럴 때는 위의 "
    + "‘새 탭’ 단추로 여세요.");
  body.appendChild(note);
  var frame = document.createElement("iframe");
  frame.src = payload.url;
  frame.title = state.current.name;
  frame.style.cssText = "width:calc(100% - 24px);height:70vh;margin:12px;border:1px solid "
    + "var(--border);border-radius:var(--radius);background:var(--surface)";
  body.appendChild(frame);
}

function renderPdfPages(payload, body, toolbar) {
  var stage = element("div", "page-stage");
  var image = document.createElement("img");
  image.alt = "";
  stage.appendChild(image);
  body.appendChild(stage);
  var bar = element("div", "slide-bar");
  var previous = element("button", null, "◀");
  var counter = element("span", "zoom", "1 / " + payload.pages);
  var next = element("button", null, "▶");
  bar.appendChild(previous);
  bar.appendChild(counter);
  bar.appendChild(next);
  body.appendChild(bar);

  function show(number) {
    state.page = Math.min(payload.pages - 1, Math.max(0, number));
    var width = Math.round(stage.clientWidth * (window.devicePixelRatio || 1) * state.zoom);
    var data = "";
    try {
      data = window.AndroidHost.pdfPage(state.page, width || 1000);
    } catch (error) {
      data = "";
    }
    if (data) {
      image.src = "data:image/jpeg;base64," + data;
      image.style.width = (100 * state.zoom) + "%";
    } else {
      renderMessage("이 쪽을 그리지 못했습니다",
                    (state.page + 1) + "쪽을 그리는 중 문제가 생겼습니다.", true);
      return;
    }
    counter.textContent = (state.page + 1) + " / " + payload.pages;
    dom["title"].textContent = state.current.name;
  }

  previous.addEventListener("click", function () { show(state.page - 1); });
  next.addEventListener("click", function () { show(state.page + 1); });
  var startX = null;
  stage.addEventListener("touchstart", function (event) {
    startX = event.touches[0].clientX;
  }, { passive: true });
  stage.addEventListener("touchend", function (event) {
    if (startX === null) { return; }
    var delta = event.changedTouches[0].clientX - startX;
    if (Math.abs(delta) > 50) { show(state.page + (delta < 0 ? 1 : -1)); }
    startX = null;
  });
  addZoom(toolbar, function () { show(state.page); });
  addButton(toolbar, "↗ 다른 앱", function () {
    try { window.AndroidHost.openElsewhere(payload.hostId); } catch (error) { /* gone */ }
  }, false);
  state.page = 0;
  show(0);
}

function renderImage(payload, body, toolbar) {
  var stage = element("div", "image-stage");
  var image = document.createElement("img");
  image.src = payload.url;
  image.alt = state.current.name;
  stage.appendChild(image);
  body.appendChild(stage);
  function apply() {
    image.style.transform = "scale(" + state.zoom + ") rotate(" + state.rotation + "deg)";
  }
  addButton(toolbar, "↻ 회전", function () {
    state.rotation = (state.rotation + 90) % 360;
    apply();
  });
  addZoom(toolbar, apply);
  addShare(toolbar, payload.url, state.current.name);
  image.addEventListener("load", function () {
    var meta = element("div", "meta", image.naturalWidth + " × " + image.naturalHeight
      + " · " + formatSize(state.current.size));
    body.insertBefore(meta, stage);
  });
}

function renderDocument(payload, body, toolbar) {
  var page = element("article", "card doc");
  page.innerHTML = payload.html;
  body.appendChild(page);
  addZoom(toolbar, function () { page.style.setProperty("--zoom", state.zoom); });
}

function renderText(payload, body, toolbar) {
  var page = element("div", "card");
  var pre = element("pre", "text", payload.text);
  page.appendChild(pre);
  body.appendChild(page);
  addZoom(toolbar, function () { page.style.setProperty("--zoom", state.zoom); });
}

function renderSpreadsheet(payload, body, toolbar) {
  var tabs = element("div", "tabs");
  var wrap = element("div", "grid-wrap");
  if (payload.sheets.length > 1) { body.appendChild(tabs); }
  body.appendChild(wrap);
  function show(index) {
    state.sheet = index;
    Array.prototype.forEach.call(tabs.children, function (tab, position) {
      tab.setAttribute("aria-pressed", String(position === index));
    });
    wrap.textContent = "";
    wrap.appendChild(buildGrid(payload.sheets[index]));
    wrap.style.setProperty("--zoom", state.zoom);
  }
  payload.sheets.forEach(function (sheet, index) {
    addButton(tabs, sheet.name, function () { show(index); }, index === 0);
  });
  addZoom(toolbar, function () { wrap.style.setProperty("--zoom", state.zoom); });
  show(0);
}

function buildGrid(sheet) {
  var columns = 0;
  sheet.rows.forEach(function (row) { columns = Math.max(columns, row.length); });
  var skip = {}, spans = {};
  (sheet.merges || []).forEach(function (merge) {
    spans[merge.r + ":" + merge.c] = merge;
    for (var r = merge.r; r < merge.r + merge.rs; r++) {
      for (var c = merge.c; c < merge.c + merge.cs; c++) {
        if (r !== merge.r || c !== merge.c) { skip[r + ":" + c] = true; }
      }
    }
  });
  var table = element("table", "grid");
  var head = document.createElement("thead");
  var headRow = document.createElement("tr");
  headRow.appendChild(document.createElement("th"));
  for (var index = 0; index < columns; index++) {
    headRow.appendChild(element("th", null, columnName(index)));
  }
  head.appendChild(headRow);
  table.appendChild(head);
  var tbody = document.createElement("tbody");
  sheet.rows.forEach(function (row, rowIndex_) {
    var tr = document.createElement("tr");
    tr.appendChild(element("th", null, String(rowIndex_ + 1)));
    for (var column = 0; column < columns; column++) {
      if (skip[rowIndex_ + ":" + column]) { continue; }
      var cell = row[column];
      var td = document.createElement("td");
      var merge = spans[rowIndex_ + ":" + column];
      if (merge) {
        if (merge.rs > 1) { td.rowSpan = merge.rs; }
        if (merge.cs > 1) { td.colSpan = merge.cs; }
      }
      if (cell) {
        td.textContent = cell.v;
        td.className = cell.e ? "err" : (cell.n ? "num" : "");
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

function renderPresentation(payload, body, toolbar) {
  var wrap = element("div", "stage-wrap");
  var stage = element("div", "stage");
  stage.style.width = payload.width + "px";
  stage.style.height = payload.height + "px";
  wrap.appendChild(stage);
  body.appendChild(wrap);
  var bar = element("div", "slide-bar");
  var previous = element("button", null, "◀");
  var counter = element("span", "zoom", "1 / " + payload.slides.length);
  var next = element("button", null, "▶");
  bar.appendChild(previous);
  bar.appendChild(counter);
  bar.appendChild(next);
  body.appendChild(bar);
  var notes = element("div", "notes");
  notes.hidden = true;
  body.appendChild(notes);

  function layout() {
    var available = wrap.clientWidth - 16;
    var scale = Math.max(0.05, available / payload.width) * state.zoom;
    stage.style.transform = "scale(" + scale + ")";
    wrap.style.height = (payload.height * scale + 16) + "px";
  }

  function show(index) {
    state.slide = Math.min(payload.slides.length - 1, Math.max(0, index));
    var slide = payload.slides[state.slide];
    stage.textContent = "";
    slide.shapes.forEach(function (shape) {
      var box = element("div", "shape");
      if (shape.x !== null) {
        box.style.cssText = "left:" + shape.x + "px;top:" + shape.y + "px;width:" + shape.w
          + "px;height:" + shape.h + "px";
        if (shape.rot) { box.style.transform = "rotate(" + shape.rot + "deg)"; }
      } else {
        box.style.position = "static";
      }
      if (shape.kind === "image") {
        var image = document.createElement("img");
        image.src = shape.src;
        image.alt = "";
        box.appendChild(image);
      } else {
        box.innerHTML = shape.html;
      }
      stage.appendChild(box);
    });
    counter.textContent = (state.slide + 1) + " / " + payload.slides.length;
    notes.textContent = slide.notes || "";
    notes.hidden = !(state.notes && slide.notes);
    layout();
  }

  previous.addEventListener("click", function () { show(state.slide - 1); });
  next.addEventListener("click", function () { show(state.slide + 1); });
  var notesButton = addButton(toolbar, "발표자 노트", function () {
    state.notes = !state.notes;
    notesButton.setAttribute("aria-pressed", String(state.notes));
    show(state.slide);
  }, false);
  addZoom(toolbar, layout);
  window.addEventListener("resize", layout);
  var startX = null;
  wrap.addEventListener("touchstart", function (event) {
    startX = event.touches[0].clientX;
  }, { passive: true });
  wrap.addEventListener("touchend", function (event) {
    if (startX === null) { return; }
    var delta = event.changedTouches[0].clientX - startX;
    if (Math.abs(delta) > 50) { show(state.slide + (delta < 0 ? 1 : -1)); }
    startX = null;
  });
  document.addEventListener("keydown", function (event) {
    if (!state.payload || state.payload.kind !== "presentation") { return; }
    if (event.key === "ArrowRight") { show(state.slide + 1); }
    if (event.key === "ArrowLeft") { show(state.slide - 1); }
  });
  show(0);
}

function renderMessage(title, detail, isError) {
  dom.main.textContent = "";
  var card = element("div", "card" + (isError ? " error" : ""));
  card.appendChild(element("h3", null, title));
  if (detail) { card.appendChild(element("p", null, detail)); }
  var file = state.current;
  if (file) {
    var facts = element("div", "facts");
    facts.appendChild(element("div", null, "파일: " + (file.name || "")));
    if (file.size) { facts.appendChild(element("div", null, "크기: " + formatSize(file.size))); }
    var kind = kindOf(file.name || "") || kindFromMime(file.hostMime || file.type);
    facts.appendChild(element("div", null, "형식: " + (KIND_LABELS[kind] || "알 수 없음")
      + (file.hostMime || file.type ? " (" + (file.hostMime || file.type) + ")" : "")));
    facts.appendChild(element("div", null, "환경: " + environmentLine()));
    card.appendChild(facts);
    card.appendChild(element("p", "hint",
      "고쳐야 할 문제라면 이 화면을 캡처해서 알려 주세요."));
  }
  var buttons = element("div", "card-buttons");
  var back = element("button", null, "목록으로");
  back.addEventListener("click", showList);
  buttons.appendChild(back);
  if (window.AndroidHost && window.AndroidHost.openElsewhere && file && file.hostId) {
    var elsewhere = element("button", null, "다른 앱으로 열기");
    elsewhere.addEventListener("click", function () {
      try { window.AndroidHost.openElsewhere(file.hostId); } catch (error) { /* gone */ }
    });
    buttons.appendChild(elsewhere);
  }
  card.appendChild(buttons);
  dom.main.appendChild(card);
}

function environmentLine() {
  var parts = [];
  if (window.AndroidHost && window.AndroidHost.describe) {
    try { parts.push(window.AndroidHost.describe()); } catch (error) { /* gone */ }
  }
  parts.push(typeof DecompressionStream === "undefined" ? "내장 압축해제 없음(자체 해제 사용)"
                                                        : "내장 압축해제");
  return parts.join(" · ");
}

function restoreTheme() {
  var stored = null;
  try { stored = localStorage.getItem("docviewer-theme"); } catch (error) { stored = null; }
  // a page that embeds the viewer may have stamped its own theme already
  if (!stored) { stored = document.documentElement.getAttribute("data-theme"); }
  if (!stored && window.matchMedia
      && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    stored = "dark";
  }
  document.documentElement.setAttribute("data-theme", stored || "light");
}

function toggleTheme() {
  var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("docviewer-theme", next); } catch (error) { /* ignore */ }
}
