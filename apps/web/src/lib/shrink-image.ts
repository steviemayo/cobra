// Shrinks a photo in the browser before it is sent, so a phone picture of several megabytes becomes
// a few hundred kilobytes. Maintenance photos only need to show what was seen, not every pixel.

export const PHOTO_MAX_SIDE = 1280;
export const PHOTO_QUALITY = 0.72;

/** The size to scale to: the longest side no more than `max`, never enlarged. */
export function fitWithin(width: number, height: number, max = PHOTO_MAX_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** A picture file as base64 JPEG (no "data:" prefix), shrunk to fit. Throws when it cannot be read as an image. */
export async function shrinkImage(file: File): Promise<{ mime: 'image/jpeg'; data: string }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot prepare photos.');
    ctx.drawImage(bitmap, 0, 0, width, height);
    const url = canvas.toDataURL('image/jpeg', PHOTO_QUALITY);
    return { mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
  } finally {
    bitmap.close();
  }
}
