const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Minimal PNG generator for solid/gradient icons with rounded squircle
function createPNG(width, height) {
    const buffer = Buffer.alloc(width * height * 4);

    const cx = width / 2;
    const cy = height / 2;
    const r = width * 0.44;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            
            // Squircle distance formula: |x|^4 + |y|^4 < r^4
            const dx = Math.abs(x - cx);
            const dy = Math.abs(y - cy);
            const dist = Math.pow(dx / r, 4) + Math.pow(dy / r, 4);

            if (dist <= 1.0) {
                // Dark slate background with emerald accent
                const grad = y / height;
                const isEmeraldCenter = (dx < r * 0.55 && dy < r * 0.55 && (dy < r * 0.15 || dx < r * 0.25));
                if (isEmeraldCenter) {
                    buffer[idx] = 16;     // R
                    buffer[idx + 1] = 185; // G (Emerald)
                    buffer[idx + 2] = 129; // B
                    buffer[idx + 3] = 255; // Alpha
                } else {
                    buffer[idx] = Math.round(15 + 15 * grad);   // R #0f172a
                    buffer[idx + 1] = Math.round(23 + 20 * grad); // G
                    buffer[idx + 2] = Math.round(42 + 25 * grad); // B
                    buffer[idx + 3] = 255; // Alpha
                }
            } else {
                // Transparent outside
                buffer[idx] = 0;
                buffer[idx + 1] = 0;
                buffer[idx + 2] = 0;
                buffer[idx + 3] = 0;
            }
        }
    }

    // Build uncompressed scanlines (filter type 0 for each line)
    const rawScanlines = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
        rawScanlines[y * (1 + width * 4)] = 0; // Filter: None
        buffer.copy(rawScanlines, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
    }

    const compressed = zlib.deflateSync(rawScanlines);

    // PNG signature
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    // IHDR Chunk
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // Bit depth: 8
    ihdr[9] = 6; // Color type: RGBA
    ihdr[10] = 0; // Compression
    ihdr[11] = 0; // Filter
    ihdr[12] = 0; // Interlace
    const ihdrChunk = makeChunk('IHDR', ihdr);

    // IDAT Chunk
    const idatChunk = makeChunk('IDAT', compressed);

    // IEND Chunk
    const iendChunk = makeChunk('IEND', Buffer.alloc(0));

    return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type, data) {
    const len = data.length;
    const buf = Buffer.alloc(8 + len + 4);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 4, 'ascii');
    data.copy(buf, 8);

    // CRC32 of type + data
    const crc = crc32(buf.subarray(4, 8 + len));
    buf.writeUInt32BE(crc, 8 + len);
    return buf;
}

// Standard CRC32 table
const crcTable = [];
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
        if (c & 1) c = 0xedb88320 ^ (c >>> 1);
        else c = c >>> 1;
    }
    crcTable[n] = c >>> 0;
}

function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

const iconsDir = path.join(__dirname, '..', 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

fs.writeFileSync(path.join(iconsDir, 'icon-192.png'), createPNG(192, 192));
fs.writeFileSync(path.join(iconsDir, 'icon-512.png'), createPNG(512, 512));

console.log('✅ icon-192.png and icon-512.png successfully created in icons/');
