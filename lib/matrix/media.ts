const GIF_87A = "GIF87a";
const GIF_89A = "GIF89a";

export function bytesAreGif(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 6) return false;
  const signature = String.fromCharCode(...bytes.slice(0, 6));
  return signature === GIF_87A || signature === GIF_89A;
}

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "bin";
}

export async function normalizeMediaFile(file: File): Promise<File> {
  let mimeType = file.type.toLowerCase();
  if (!mimeType || mimeType === "application/octet-stream") {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    if (bytesAreGif(head)) mimeType = "image/gif";
  }
  if (!mimeType) mimeType = "application/octet-stream";
  const fallbackName = `sub-etha-${Date.now()}.${extensionForMime(mimeType)}`;
  const name = file.name && !file.name.startsWith("image.") ? file.name : fallbackName;
  if (file.type === mimeType && file.name === name) return file;
  return new File([file], name, { type: mimeType, lastModified: file.lastModified || Date.now() });
}

export function firstImageFile(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || (item.type && !item.type.startsWith("image/"))) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return Array.from(data.files ?? []).find((file) => !file.type || file.type.startsWith("image/")) ?? null;
}

export function insertAtSelection(value: string, insertion: string, start: number, end: number): { value: string; caret: number } {
  const safeStart = Math.max(0, Math.min(start, value.length));
  const safeEnd = Math.max(safeStart, Math.min(end, value.length));
  return {
    value: `${value.slice(0, safeStart)}${insertion}${value.slice(safeEnd)}`,
    caret: safeStart + insertion.length,
  };
}

export async function imageDimensions(file: File): Promise<{ width?: number; height?: number }> {
  if (!file.type.startsWith("image/")) return {};
  if ("createImageBitmap" in globalThis) {
    try {
      const bitmap = await createImageBitmap(file);
      const dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return dimensions;
    } catch { /* fall through to the image element path */ }
  }
  if (typeof document === "undefined") return {};
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}
