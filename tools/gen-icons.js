/* Generador de iconos PNG para la PWA (sin dependencias externas).
 * Dibuja un altavoz con ondas de sonido sobre un fondo degradado.
 * Uso: node tools/gen-icons.js
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// --- CRC32 / PNG encoder ---
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  // raw scanlines with filter byte 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Dibujo del icono (con supersampling) ---
function lerp(a, b, t) { return a + (b - a) * t; }
function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

function drawIcon(size) {
  const SS = 4;                 // supersampling
  const S = size * SS;
  const buf = Buffer.alloc(S * S * 4);

  const top = hex('#6c8cff');
  const bot = hex('#4f6ef0');
  const white = [255, 255, 255];

  function set(x, y, rgb, a = 255) {
    const i = (y * S + x) * 4;
    buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]; buf[i + 3] = a;
  }

  for (let y = 0; y < S; y++) {
    const ty = y / S;
    const bg = [
      Math.round(lerp(top[0], bot[0], ty)),
      Math.round(lerp(top[1], bot[1], ty)),
      Math.round(lerp(top[2], bot[2], ty)),
    ];
    for (let x = 0; x < S; x++) {
      const nx = x / S, ny = y / S;   // coords normalizadas 0..1
      let rgb = bg;

      // --- Altavoz ---
      // Caja: rectángulo pequeño
      let isWhite = false;
      if (nx >= 0.20 && nx <= 0.31 && ny >= 0.42 && ny <= 0.58) isWhite = true;
      // Cono: trapecio que crece hacia la derecha
      if (nx >= 0.31 && nx <= 0.45) {
        const t = (nx - 0.31) / (0.45 - 0.31);
        const half = lerp(0.08, 0.22, t);
        if (ny >= 0.5 - half && ny <= 0.5 + half) isWhite = true;
      }

      // --- Ondas de sonido (arcos) ---
      const cx = 0.46, cy = 0.5;
      const dx = nx - cx, dy = ny - cy;
      const dist = Math.hypot(dx, dy);
      const ang = Math.abs(Math.atan2(dy, dx)); // 0 = derecha
      const inAngle = ang <= (50 * Math.PI) / 180;
      const tw = 0.024;
      for (const r of [0.13, 0.21, 0.29]) {
        if (inAngle && Math.abs(dist - r) <= tw) isWhite = true;
      }

      if (isWhite) rgb = white;
      set(x, y, rgb, 255);
    }
  }

  // Downsample SSxSS -> size
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * S + (x * SS + sx)) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, out);
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
const sizes = { 'icon-192.png': 192, 'icon-512.png': 512, 'apple-touch-icon.png': 180, 'favicon-32.png': 32 };
for (const [name, size] of Object.entries(sizes)) {
  fs.writeFileSync(path.join(dir, name), drawIcon(size));
  console.log('✓', name, `(${size}x${size})`);
}
