// Draws build/icon.png (512x512): a white "B" on Bookflix red. Placeholder artwork with no dependencies; replace the file with real art any time.
import fs from 'node:fs';
import zlib from 'node:zlib';

const N = 512;
const RED = [229, 9, 20];
const WHITE = [255, 255, 255];
// 5x7 block letter
const B = ['1111.', '1...1', '1...1', '1111.', '1...1', '1...1', '1111.'];
const cell = 44;
const ox = Math.round((N - 5 * cell) / 2);
const oy = Math.round((N - 7 * cell) / 2);
const radius = 96;

const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    // rounded-square mask
    const dx = Math.max(radius - x, 0, x - (N - 1 - radius));
    const dy = Math.max(radius - y, 0, y - (N - 1 - radius));
    const inside = dx * dx + dy * dy <= radius * radius;
    const cx = Math.floor((x - ox) / cell);
    const cy = Math.floor((y - oy) / cell);
    const ink = cx >= 0 && cx < 5 && cy >= 0 && cy < 7 && B[cy][cx] === '1';
    const [r, g, b] = ink ? WHITE : RED;
    const i = y * (N * 4 + 1) + 1 + x * 4;
    raw[i] = r;
    raw[i + 1] = g;
    raw[i + 2] = b;
    raw[i + 3] = inside ? 255 : 0;
  }
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);

fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/icon.png', png);
console.log(`build/icon.png (${png.length} bytes)`);
