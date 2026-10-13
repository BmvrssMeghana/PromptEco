import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create icons directory
const iconsDir = path.resolve(__dirname, '../public/icons');
fs.mkdirSync(iconsDir, { recursive: true });

// Master SVG
const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="leafGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#10B981" />
      <stop offset="100%" stop-color="#059669" />
    </linearGradient>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#111827" />
      <stop offset="100%" stop-color="#1F2937" />
    </linearGradient>
  </defs>
  <!-- Background Circle -->
  <circle cx="64" cy="64" r="60" fill="url(#bgGrad)" stroke="#374151" stroke-width="2"/>
  
  <!-- Subtle Eco Ring -->
  <circle cx="64" cy="64" r="52" fill="none" stroke="#10B981" stroke-width="1.5" stroke-dasharray="4 4" opacity="0.4"/>
  
  <!-- Sleek Leaf & Energy Spark Motif -->
  <path d="M 64 26 C 88 28, 98 48, 96 74 C 94 94, 76 102, 64 102 C 52 102, 34 94, 32 74 C 30 48, 40 28, 64 26 Z" 
        fill="url(#leafGrad)" />
        
  <!-- Center Leaf Vein / Clean Tech Line -->
  <path d="M 64 36 L 64 94" stroke="#ECFDF5" stroke-width="3" stroke-linecap="round" opacity="0.9"/>
  <path d="M 64 54 Q 74 48, 82 52" stroke="#ECFDF5" stroke-width="2.2" stroke-linecap="round" fill="none" opacity="0.8"/>
  <path d="M 64 68 Q 54 62, 46 66" stroke="#ECFDF5" stroke-width="2.2" stroke-linecap="round" fill="none" opacity="0.8"/>
  
  <!-- Spark/Prompt Pulse Dot -->
  <circle cx="64" cy="32" r="3.5" fill="#34D399" />
</svg>`;

fs.writeFileSync(path.join(iconsDir, 'icon.svg'), svgContent, 'utf-8');

// Function to generate raw uncompressed RGBA pixel buffer for an icon of given size
function createIconRGBA(size) {
  const buf = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const radius = size * 0.46;
  const leafRadius = size * 0.35;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - center;
      const dy = y - center;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= radius) {
        // Dark premium background (#111827)
        let r = 17, g = 24, b = 39, a = 255;

        // Anti-aliasing border
        if (dist > radius - 1) {
          a = Math.floor(255 * (radius - dist));
        }

        // Inner Leaf shape check
        // Normalized coordinates [-1, 1]
        const nx = dx / leafRadius;
        const ny = (dy + size * 0.04) / leafRadius;

        // Leaf curve formula
        const inLeaf = (nx * nx + Math.pow(ny - Math.sqrt(Math.abs(nx)), 2)) < 1.1 && Math.abs(nx) < 0.85 && ny > -1.2 && ny < 1.2;

        if (inLeaf) {
          // Emerald Green gradient (#10B981 to #059669)
          const grad = (ny + 1) / 2;
          r = Math.floor(16 * (1 - grad) + 5 * grad);
          g = Math.floor(185 * (1 - grad) + 150 * grad);
          b = Math.floor(129 * (1 - grad) + 105 * grad);

          // Center stem line
          if (Math.abs(dx) <= Math.max(1, size * 0.03) && dy > -leafRadius * 0.8 && dy < leafRadius * 0.8) {
            r = 236; g = 253; b = 245;
          }
        }

        buf[idx] = r;
        buf[idx + 1] = g;
        buf[idx + 2] = b;
        buf[idx + 3] = a;
      } else {
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 0;
      }
    }
  }
  return buf;
}

// Minimal valid PNG generator
function encodePNG(width, height, rgbaBuffer) {
  // CRC32 table
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c;
  }
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type, data) {
    const len = data.length;
    const buf = Buffer.alloc(12 + len);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 4, 'ascii');
    data.copy(buf, 8);
    const crc = crc32(buf.subarray(4, 8 + len));
    buf.writeUInt32BE(crc, 8 + len);
    return buf;
  }

  // PNG Signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = makeChunk('IHDR', ihdr);

  // Scanlines with filter byte 0 (None)
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (1 + width * 4);
    scanlines[rowOffset] = 0; // Filter: None
    rgbaBuffer.copy(scanlines, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressedData = zlib.deflateSync(scanlines);
  const idatChunk = makeChunk('IDAT', compressedData);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

[16, 32, 48, 128].forEach(size => {
  const rgba = createIconRGBA(size);
  const pngBuf = encodePNG(size, size, rgba);
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), pngBuf);
  console.log(`Generated icon${size}.png (${size}x${size})`);
});
console.log('All icons generated successfully!');
