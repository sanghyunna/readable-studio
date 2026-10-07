import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

type Entry = { name: string; offset: number; end: number; central: Buffer; source: FileHandle };

async function readAt(file: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await file.read(buffer, done, length - done, position + done);
    if (bytesRead === 0) throw new Error("truncated ZIP shard");
    done += bytesRead;
  }
  return buffer;
}

async function entries(file: FileHandle): Promise<Entry[] | null> {
  const size = (await file.stat()).size;
  const tail = await readAt(file, Math.min(size, 65557), Math.max(0, size - 65557));
  const footer = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (footer < 0 || footer + 22 > tail.length || footer + 22 + tail.readUInt16LE(footer + 20) !== tail.length) {
    throw new Error("invalid ZIP shard end record");
  }
  if (tail.readUInt16LE(footer + 4) || tail.readUInt16LE(footer + 6)) throw new Error("multi-disk ZIP shard");
  const count = tail.readUInt16LE(footer + 10);
  const centralSize = tail.readUInt32LE(footer + 12);
  const centralOffset = tail.readUInt32LE(footer + 16);
  // ZIP64 requires extended offsets/counts; preserve its existing single-process path.
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) return null;
  const central = await readAt(file, centralSize, centralOffset);
  const result: Entry[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    if (central.readUInt32LE(cursor) !== 0x02014b50) throw new Error("invalid ZIP shard central record");
    const length = 46 + central.readUInt16LE(cursor + 28) + central.readUInt16LE(cursor + 30) + central.readUInt16LE(cursor + 32);
    const record = Buffer.from(central.subarray(cursor, cursor + length));
    const offset = record.readUInt32LE(42);
    if (offset === 0xffffffff || record.readUInt32LE(20) === 0xffffffff || record.readUInt32LE(24) === 0xffffffff) return null;
    const name = record.subarray(46, 46 + record.readUInt16LE(28)).toString("utf8");
    result.push({ name, offset, end: centralOffset, central: record, source: file });
    cursor += length;
  }
  if (cursor !== central.length) throw new Error("ZIP shard central size mismatch");
  const physical = [...result].sort((a, b) => a.offset - b.offset);
  for (let i = 0; i < physical.length; i++) {
    physical[i]!.end = physical[i + 1]?.offset ?? centralOffset;
    if (physical[i]!.end <= physical[i]!.offset) throw new Error("invalid ZIP shard local offset");
  }
  return result;
}

// Preserve each complete local record (including compressed bytes/descriptors)
// and central metadata. Only central offsets and the final end record change.
// Handles remain open: merging must not replace 24k source opens with 24k shard opens.
export async function mergeWinZipShards(paths: readonly string[], output: string): Promise<boolean> {
  const sources: FileHandle[] = [];
  let target: FileHandle | undefined;
  try {
    const all: Entry[] = [];
    for (const path of paths) {
      const source = await open(path, "r");
      sources.push(source);
      const parsed = await entries(source);
      if (parsed == null) return false;
      all.push(...parsed);
    }
    // 7-Zip's Windows filename order is case-insensitive, not JS code-point order.
    all.sort((a, b) => {
      const left = a.name.toUpperCase();
      const right = b.name.toUpperCase();
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const names = new Set<string>();
    for (const entry of all) {
      if (names.has(entry.name)) throw new Error(`duplicate ZIP shard entry: ${entry.name}`);
      names.add(entry.name);
    }
    const localSize = all.reduce((sum, entry) => sum + entry.end - entry.offset, 0);
    const centralSize = all.reduce((sum, entry) => sum + entry.central.length, 0);
    if (all.length >= 0xffff || localSize + centralSize + 22 >= 0xffffffff) return false;
    target = await open(output, "wx");
    const buffer = Buffer.alloc(1024 * 1024);
    const write = async (bytes: Buffer) => {
      let done = 0;
      while (done < bytes.length) {
        const result = await target!.write(bytes, done, bytes.length - done, null);
        if (result.bytesWritten === 0) throw new Error("ZIP merge write made no progress");
        done += result.bytesWritten;
      }
    };
    let position = 0;
    for (const entry of all) {
      entry.central.writeUInt32LE(position, 42);
      let cursor = entry.offset;
      while (cursor < entry.end) {
        const length = Math.min(buffer.length, entry.end - cursor);
        const { bytesRead } = await entry.source.read(buffer, 0, length, cursor);
        if (bytesRead === 0) throw new Error("truncated ZIP shard local record");
        await write(buffer.subarray(0, bytesRead));
        cursor += bytesRead;
        position += bytesRead;
      }
    }
    for (const entry of all) await write(entry.central);
    const footer = Buffer.alloc(22);
    footer.writeUInt32LE(0x06054b50, 0);
    footer.writeUInt16LE(all.length, 8);
    footer.writeUInt16LE(all.length, 10);
    footer.writeUInt32LE(centralSize, 12);
    footer.writeUInt32LE(localSize, 16);
    await write(footer);
    return true;
  } finally {
    await target?.close();
    await Promise.all(sources.map((source) => source.close()));
  }
}
