/** Dev-only attachment store for the mock server: drafts, posting, expiry and content, all in memory. */
import { randomBytes } from 'node:crypto';
import type { Schema } from './protocol.ts';

export interface StoredAttachment {
  meta: Schema['Attachment'];
  roomId: string;
  ownerId: string;
  data: Buffer;
}

export const attachmentLimits: Schema['AttachmentLimits'] = {
  maxFileBytes: 26_214_400, maxOutputBytes: 33_554_432, stagingBytes: 268_435_456, postedBytes: 5_000_000_000,
  maxAttachments: 4, maxPending: 4, maxUploadStreams: 4, maxPixels: 24_000_000, maxEdge: 16_384, maxDimension: 2560,
  draftTtlSeconds: 3600, processTimeoutSeconds: 30, uploadTimeoutSeconds: 60, uploadBurst: 4, uploadRefillSeconds: 15,
  multipartOverheadBytes: 16_384, multipartHeaderBytes: 8192, maxContentStreams: 8, contentTimeoutSeconds: 120, maxConversions: 1,
};

/** Reads the type and size of the common image formats from their first bytes. */
export function sniffImage(data: Buffer): { contentType: string; width: number; height: number } | null {
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) return { contentType: 'image/png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data.length > 10 && data.toString('ascii', 0, 3) === 'GIF') return { contentType: 'image/gif', width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (data.length > 30 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = data.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { contentType: 'image/webp', width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    if (chunk === 'VP8L') {
      const bits = data.readUInt32LE(21);
      return { contentType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { contentType: 'image/webp', width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
  }
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let at = 2;
    while (at + 9 < data.length) {
      if (data[at] !== 0xff) { at++; continue; }
      const marker = data[at + 1]!;
      const length = data.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { contentType: 'image/jpeg', height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) };
      }
      at += 2 + length;
    }
    return { contentType: 'image/jpeg', width: 0, height: 0 };
  }
  const head = data.toString('utf8', 0, Math.min(data.length, 512));
  const svg = /<svg[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/.exec(head);
  if (svg) return { contentType: 'image/svg+xml', width: Number(svg[1]), height: Number(svg[2]) };
  return null;
}

/** The one file part of a multipart body, as the real server accepts it. */
export function parseMultipart(contentType: string, raw: Buffer): { filename: string; data: Buffer } | null {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundary) return null;
  const marker = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const start = raw.indexOf(marker);
  if (start < 0) return null;
  const headEnd = raw.indexOf('\r\n\r\n', start);
  const end = raw.indexOf(Buffer.concat([Buffer.from('\r\n'), marker]), headEnd);
  if (headEnd < 0 || end < 0) return null;
  const headers = raw.toString('utf8', start + marker.length, headEnd);
  const filename = /filename="([^"]*)"/i.exec(headers)?.[1] ?? 'file';
  return { filename: filename.split(/[\\/]/).pop() || 'file', data: raw.subarray(headEnd + 4, end) };
}

const hues: Array<[number, number]> = [[205, 265], [18, 340], [160, 210], [40, 12], [280, 320], [95, 160]];

/** A picture for the fixtures: soft gradients and circles, recognisably different from one another. */
export function fixtureImage(seed: number, width: number, height: number): Buffer {
  const [a, b] = hues[seed % hues.length]!;
  const circles = Array.from({ length: 5 }, (_, i) => {
    const x = ((seed * 37 + i * 211) % 100) / 100 * width;
    const y = ((seed * 53 + i * 131) % 100) / 100 * height;
    const r = (0.12 + ((seed + i) % 5) * 0.05) * Math.min(width, height);
    return `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(0)}" fill="hsl(${(a + i * 25) % 360} 85% ${55 + i * 6}%)" opacity=".55"/>`;
  }).join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${a} 70% 45%)"/><stop offset="1" stop-color="hsl(${b} 75% 30%)"/></linearGradient>`
    + `<filter id="b"><feGaussianBlur stdDeviation="${Math.round(Math.min(width, height) / 18)}"/></filter></defs>`
    + `<rect width="100%" height="100%" fill="url(#g)"/><g filter="url(#b)">${circles}</g>`
    + `<text x="50%" y="52%" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${Math.round(Math.min(width, height) / 9)}" fill="rgba(255,255,255,.85)">${width}×${height}</text></svg>`);
}

export function newAttachmentId(): string {
  return randomBytes(16).toString('hex');
}
