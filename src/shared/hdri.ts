/** Panorama formats the packaged runtime loader accepts. */
export const HDRI_EXTENSIONS = ['hdr', 'exr', 'jpg', 'jpeg', 'png'] as const;

export type HdriExtension = typeof HDRI_EXTENSIONS[number];

export interface HdriTexture {
  /** Filename without extension. Stable id a render scheme refers to. */
  id: string;
  /** Filename as it sits on disk, used to build the download URL. */
  file: string;
  extension: HdriExtension;
  bytes: number;
}

export function hdriExtensionOf(file: string): HdriExtension | null {
  const extension = file.split('.').pop()?.toLowerCase() ?? '';
  return (HDRI_EXTENSIONS as readonly string[]).includes(extension)
    ? extension as HdriExtension
    : null;
}
