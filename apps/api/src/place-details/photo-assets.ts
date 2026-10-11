import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CuratedPhotoAssetInput } from "@along-the-way/contracts/place-details";

export const packagedPhotoRoot = fileURLToPath(new URL("../../assets/place-photos/", import.meta.url));
const MAX_ASSET_BYTES = 20 * 1024 * 1024;

/** No symlinks, path traversal, unbounded reads, or network fallback. */
export async function readPackagedPhoto(root: string, filename: string): Promise<Buffer<ArrayBuffer>> {
  if (!/^[a-f0-9]{64}\.(jpg|png|webp)$/.test(filename)) throw new Error("Invalid photo filename");
  const file = await open(join(root, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 12 || stat.size > MAX_ASSET_BYTES) throw new Error("Invalid photo file size");
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw new Error("Photo changed during read");
      offset += read.bytesRead;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== filename.slice(0, 64)) {
      throw new Error(`Photo checksum mismatch: ${filename}`);
    }
    return bytes;
  } finally {
    await file.close();
  }
}

/** Bounded container validation reads dimensions from bytes, never from the extension. */
function imageDimensions(bytes: Buffer, mediaType: CuratedPhotoAssetInput["mediaType"]): [number, number] {
  if (mediaType === "image/png") {
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Invalid PNG signature");
    let offset = 8;
    let dimensions: [number, number] | null = null;
    let dataSeen = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (length > MAX_ASSET_BYTES || offset + 12 + length > bytes.length) throw new Error("Truncated PNG chunk");
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      if (offset === 8 && (type !== "IHDR" || length !== 13)) throw new Error("Missing PNG dimensions");
      if (type === "IHDR") {
        if (dimensions || length !== 13) throw new Error("Invalid PNG header");
        dimensions = [bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12)];
      }
      if (type === "IDAT" && length > 0) dataSeen = true;
      if (type === "IEND") {
        if (length !== 0 || offset + 12 !== bytes.length || !dataSeen || !dimensions) throw new Error("Invalid PNG end");
        return dimensions;
      }
      offset += length + 12;
    }
    throw new Error("Incomplete PNG");
  }
  if (mediaType === "image/jpeg") {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
      throw new Error("Invalid JPEG signature/end");
    }
    let offset = 2;
    let dimensions: [number, number] | null = null;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) throw new Error("Invalid JPEG marker");
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === undefined) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) throw new Error("Truncated JPEG segment");
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8 || dimensions) throw new Error("Invalid JPEG frame");
        dimensions = [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
      }
      if (marker === 0xda) {
        if (!dimensions || offset + length >= bytes.length - 2) throw new Error("Missing JPEG image data");
        return dimensions;
      }
      offset += length;
    }
    throw new Error("Incomplete JPEG");
  }
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP" || bytes.readUInt32LE(4) + 8 !== bytes.length) {
    throw new Error("Invalid WebP container");
  }
  let offset = 12;
  let dimensions: [number, number] | null = null;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > bytes.length) throw new Error("Truncated WebP chunk");
    if (type === "VP8 " && length >= 10) {
      if (bytes[start + 3] !== 0x9d || bytes[start + 4] !== 0x01 || bytes[start + 5] !== 0x2a) throw new Error("Invalid WebP frame");
      dimensions = [bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff];
    } else if (type === "VP8L" && length >= 5) {
      if (bytes[start] !== 0x2f) throw new Error("Invalid lossless WebP frame");
      const bits = bytes.readUInt32LE(start + 1);
      dimensions = [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    } else if (type === "ANIM" || type === "ANMF") {
      throw new Error("Animated photos are not supported");
    }
    offset = start + length + (length % 2);
  }
  if (offset !== bytes.length || !dimensions) throw new Error("Incomplete WebP");
  return dimensions;
}

export async function verifyPackagedPhoto(root: string, asset: CuratedPhotoAssetInput): Promise<void> {
  const bytes = await readPackagedPhoto(root, asset.filename);
  if (asset.filename.slice(0, 64) !== asset.sha256) throw new Error(`Photo checksum metadata mismatch: ${asset.filename}`);
  const [width, height] = imageDimensions(bytes, asset.mediaType);
  if (width !== asset.width || height !== asset.height || width * height > 100_000_000) {
    throw new Error(`Photo dimensions mismatch or exceed limit: ${asset.filename}`);
  }
}
