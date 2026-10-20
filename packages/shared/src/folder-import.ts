import { z } from 'zod';

export const FOLDER_SCAN_LIMIT = 1000;
export const FOLDER_GROUP_LIMIT = 20;
export const FOLDER_ACTOR_HEADER = 'X-PicFind-Upload-Actor';
const safeParts = (path: string) =>
  !/[\\:]/.test(path) &&
  ![...path].some(
    (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
  ) &&
  path.split('/').every((part) => part && part !== '.' && part !== '..');
export const relativePhotoPath = z
  .string()
  .min(1)
  .max(512)
  .refine((path) => safeParts(path) && path.split('/').length >= 2);
export const folderMappingSchema = z
  .object({
    path: z.string().min(1).max(510).refine(safeParts),
    title: z.string().trim().min(1).max(100),
    collectionId: z.uuid(),
    createCollection: z.boolean(),
  })
  .strict();
export const folderMappingsSchema = z
  .array(folderMappingSchema)
  .min(1)
  .max(FOLDER_GROUP_LIMIT)
  .refine(
    (rows) =>
      new Set(rows.map((row) => row.path)).size === rows.length &&
      new Set(rows.map((row) => row.collectionId)).size === rows.length,
  );
export type FolderMapping = z.infer<typeof folderMappingSchema>;
export const folderCollectionCommand = z
  .object({
    title: z.string().trim().min(1).max(100),
    photoIds: z.array(z.uuid()).min(1).max(100),
  })
  .strict()
  .refine((data) => new Set(data.photoIds).size === data.photoIds.length);

export interface FolderFile {
  file: File;
  path: string;
  folder: string;
  reason: string | null;
}
export function inspectFolder(files: File[]): FolderFile[] {
  if (!files.length || files.length > FOLDER_SCAN_LIMIT)
    throw new Error(
      `Choose a folder containing 1 to ${FOLDER_SCAN_LIMIT} files.`,
    );
  const seen = new Set<string>();
  return files.map((file) => {
    const path = file.webkitRelativePath;
    if (
      !relativePhotoPath.safeParse(path).success ||
      path.split('/').at(-1) !== file.name ||
      seen.has(path)
    )
      throw new Error(
        `This folder contains missing, unsafe or duplicate relative paths. File: ${JSON.stringify(file.name.slice(0, 255))}. Choose an unambiguous folder.`,
      );
    seen.add(path);
    const extension = file.name.split('.').at(-1)?.toLowerCase();
    const expected =
      extension === 'jpg' || extension === 'jpeg'
        ? 'image/jpeg'
        : extension === 'png'
          ? 'image/png'
          : extension === 'webp'
            ? 'image/webp'
            : null;
    const reason = !expected
      ? 'Unsupported file type'
      : file.type !== expected
        ? 'Image type does not match its extension'
        : file.name.length > 255
          ? 'Filename exceeds 255 characters'
          : !file.size
            ? 'Empty file'
            : file.size > 8 * 1024 * 1024
              ? 'File exceeds 8 MiB'
              : null;
    return { file, path, folder: path.slice(0, path.lastIndexOf('/')), reason };
  });
}
