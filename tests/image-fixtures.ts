export const validPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

export const validGif = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  'base64',
);

export const validWebp = Buffer.from(
  'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA=',
  'base64',
);

export const validLosslessWebp = Buffer.from(
  'UklGRhoAAABXRUJQVlA4TA4AAAAvAAAAAAcQEf0PRET/Aw==',
  'base64',
);

export const validAnimatedWebp = Buffer.from(
  'UklGRoQAAABXRUJQVlA4WAoAAAACAAAAAAAAAAAAQU5JTQYAAAD/////AABBTk1GKAAAAAAAAAAAAAAAAAAAAGQAAAJWUDhMDwAAAC8AAAAABxD9j/4HIqL/AQBBTk1GKAAAAAAAAAAAAAAAAAAAAGQAAABWUDhMDwAAAC8AAAAABxDR//4HIqL/AQA=',
  'base64',
);

const validAnimatedWebpFrames = [
  'UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ/Y/+ByKi/wEA',
  'UklGRhwAAABXRUJQVlA4TA8AAAAvAAAAAAcQ0f/+ByKi/wEA',
];

const decodedWebpFixtures = new Set([
  validWebp.toString('base64'),
  validLosslessWebp.toString('base64'),
  ...validAnimatedWebpFrames,
]);

export const fixtureWebpDecoder = async (
  content: Uint8Array,
): Promise<{ width: number; height: number } | undefined> =>
  decodedWebpFixtures.has(Buffer.from(content).toString('base64'))
    ? { width: 1, height: 1 }
    : undefined;

export const validJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=',
  'base64',
);

export function pngChunk(type: string, payload: Uint8Array): Buffer {
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length, 0);
  chunk.write(type, 4, 'ascii');
  Buffer.from(payload).copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + payload.length)), 8 + payload.length);
  return chunk;
}

function crc32(content: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
