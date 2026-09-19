/* A small PDF writer for scanned pages - a port of docscan/pdf.py.
 *
 * Colour and grayscale pages are embedded as JPEG (DCTDecode), bi-level pages
 * as deflated one-bit-per-pixel data (FlateDecode), which keeps text scans
 * very small and lossless.
 */

export const PAPER_SIZES = {
  a3: [841.89, 1190.55],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  letter: [612, 792],
  legal: [612, 1008],
};

const encoder = new TextEncoder();

class ByteBuilder {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  push(part) {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    this.chunks.push(bytes);
    this.length += bytes.length;
    return this;
  }

  toBytes() {
    const output = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }
}

/** ASCII as a literal string, anything else (Korean titles) as UTF-16BE hex. */
function pdfText(text) {
  const value = String(text);
  if (/^[\x20-\x7e]*$/.test(value)) {
    return "(" + value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)") + ")";
  }
  let hex = "FEFF";
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code > 0xffff) {
      const shifted = code - 0x10000;
      hex += (0xd800 + (shifted >> 10)).toString(16).padStart(4, "0");
      hex += (0xdc00 + (shifted & 0x3ff)).toString(16).padStart(4, "0");
    } else {
      hex += code.toString(16).padStart(4, "0");
    }
  }
  return "<" + hex.toUpperCase() + ">";
}

/** Number of colour components declared in a JPEG's frame header. */
function jpegComponents(bytes) {
  for (let index = 2; index + 9 < bytes.length;) {
    if (bytes[index] !== 0xff) { index += 1; continue; }
    const marker = bytes[index + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      index += 2;
      continue;
    }
    const length = (bytes[index + 2] << 8) | bytes[index + 3];
    const isFrame = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return bytes[index + 9];
    if (marker === 0xda) break;             // start of scan: no frame header found
    index += 2 + length;
  }
  return 3;
}

async function deflate(bytes) {
  if (typeof CompressionStream !== "function") return null;
  // "deflate" is the zlib wrapped variant, which is what FlateDecode expects
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function isBiLevel(imageData) {
  const { data } = imageData;
  for (let index = 0; index < data.length; index += 4) {
    const value = data[index];
    if (value !== 0 && value !== 255) return false;
    if (data[index + 1] !== value || data[index + 2] !== value) return false;
  }
  return true;
}

async function encodePage(canvas, quality) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  if (isBiLevel(imageData)) {
    const rowBytes = Math.ceil(canvas.width / 8);
    const packed = new Uint8Array(rowBytes * canvas.height);
    for (let row = 0; row < canvas.height; row += 1) {
      for (let column = 0; column < canvas.width; column += 1) {
        if (imageData.data[(row * canvas.width + column) * 4] > 127) {
          packed[row * rowBytes + (column >> 3)] |= 0x80 >> (column & 7);
        }
      }
    }
    const compressed = await deflate(packed);
    if (compressed) {
      return { data: compressed, filter: "FlateDecode", colourSpace: "DeviceGray", bits: 1 };
    }
    // no CompressionStream (older Safari): fall back to a JPEG page
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality / 100));
  const data = new Uint8Array(await blob.arrayBuffer());
  const components = jpegComponents(data);
  return {
    data,
    filter: "DCTDecode",
    colourSpace: components === 1 ? "DeviceGray" : "DeviceRGB",
    bits: 8,
  };
}

function pageBox(width, height, dpi, pageSize) {
  const naturalWidth = (width * 72) / dpi;
  const naturalHeight = (height * 72) / dpi;
  if (!pageSize || pageSize === "auto" || pageSize === "fit") {
    return [naturalWidth, naturalHeight, naturalWidth, naturalHeight, 0, 0];
  }
  const size = PAPER_SIZES[pageSize];
  if (!size) throw new Error("unknown page size: " + pageSize);
  let [paperWidth, paperHeight] = size;
  if (naturalWidth > naturalHeight) [paperWidth, paperHeight] = [paperHeight, paperWidth];
  const scale = Math.min(paperWidth / naturalWidth, paperHeight / naturalHeight);
  const drawWidth = naturalWidth * scale;
  const drawHeight = naturalHeight * scale;
  return [paperWidth, paperHeight, drawWidth, drawHeight,
          (paperWidth - drawWidth) / 2, (paperHeight - drawHeight) / 2];
}

/**
 * Build a PDF from canvases (one per page).
 * Returns a Blob ready to be downloaded or shared.
 */
export async function buildPdf(canvases, { dpi = 300, quality = 92, title = null,
                                           pageSize = "auto" } = {}) {
  if (!canvases.length) throw new Error("at least one page is required");
  if (dpi <= 0) throw new Error("dpi must be positive");

  const objects = [];
  const add = (parts) => { objects.push(parts); return objects.length; };

  const catalogNumber = add(null);
  const pagesNumber = add(null);
  const pageNumbers = [];

  for (let index = 0; index < canvases.length; index += 1) {
    const canvas = canvases[index];
    const { data, filter, colourSpace, bits } = await encodePage(canvas, quality);
    const [pageWidth, pageHeight, drawWidth, drawHeight, offsetX, offsetY] = pageBox(
      canvas.width, canvas.height, dpi, pageSize);

    const imageNumber = add([
      `<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} `
      + `/ColorSpace /${colourSpace} /BitsPerComponent ${bits} /Filter /${filter} `
      + `/Length ${data.length} >>\nstream\n`,
      data,
      "\nendstream",
    ]);
    const content = `q\n${drawWidth.toFixed(4)} 0 0 ${drawHeight.toFixed(4)} `
      + `${offsetX.toFixed(4)} ${offsetY.toFixed(4)} cm\n/Im${index} Do\nQ\n`;
    const contentNumber = add([
      `<< /Length ${encoder.encode(content).length} >>\nstream\n`, content, "\nendstream",
    ]);
    pageNumbers.push(add([
      `<< /Type /Page /Parent ${pagesNumber} 0 R /MediaBox [0 0 ${pageWidth.toFixed(4)} `
      + `${pageHeight.toFixed(4)}] /Resources << /XObject << /Im${index} ${imageNumber} 0 R >> >> `
      + `/Contents ${contentNumber} 0 R >>`,
    ]));
  }

  objects[catalogNumber - 1] = [`<< /Type /Catalog /Pages ${pagesNumber} 0 R >>`];
  objects[pagesNumber - 1] = [
    `<< /Type /Pages /Count ${pageNumbers.length} /Kids [`
    + pageNumbers.map((number) => `${number} 0 R`).join(" ") + "] >>",
  ];

  const stamp = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const timestamp = `D:${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}`
    + `${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
  const info = ["/Producer (docscan)", `/CreationDate (${timestamp})`];
  if (title) info.unshift(`/Title ${pdfText(title)}`);
  const infoNumber = add([`<< ${info.join(" ")} >>`]);

  const builder = new ByteBuilder();
  builder.push("%PDF-1.4\n").push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const offsets = [];
  objects.forEach((parts, index) => {
    offsets.push(builder.length);
    builder.push(`${index + 1} 0 obj\n`);
    parts.forEach((part) => builder.push(part));
    builder.push("\nendobj\n");
  });

  const xrefOffset = builder.length;
  builder.push(`xref\n0 ${objects.length + 1}\n`).push("0000000000 65535 f \n");
  offsets.forEach((offset) => builder.push(`${String(offset).padStart(10, "0")} 00000 n \n`));
  builder.push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogNumber} 0 R `
               + `/Info ${infoNumber} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return new Blob([builder.toBytes()], { type: "application/pdf" });
}
