export interface User {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
}
export interface Photo {
  credit?: import('../../../packages/shared/src/photo-attribution').PublishedAttribution;
  id: string;
  expiresAt?: string;
  filename: string;
  createdAt: string;
  eventId?: string;
  bytes: number;
  width: number;
  height: number;
}
export interface GalleryEvent {
  accessRole?: 'owner' | 'moderator';
  id: string;
  folder?: string;
  title: string;
  description: string;
  date: string;
  visibility: 'private' | 'link';
  archived: boolean;
  expiresAt: string;
  createdAt: string;
}
export interface ImportJob {
  id: string;
  state: string;
  imported: number;
  errors: string[];
  createdAt: string;
}
export interface FaceMatch {
  photoId: string;
  filename: string;
  similarity: number;
  width?: number;
  height?: number;
}
export interface DiscoverProcessing {
  id: string;
  requestId: string;
  type: string;
  status: string;
  total: number;
  processed: number;
  indexed: number;
  empty: number;
  failed: number;
  cancelRequested: boolean;
  failureCode?: string;
}
export interface DiscoverScan {
  requestId?: string;
  resultsRetained?: boolean;
  deleting?: boolean;
  processing?: DiscoverProcessing;
  id: string;
  state: string;
  imported: number;
  indexed: number;
  errors: string[];
  createdAt: string;
  provider?: string;
  modelVersion?: string;
  matches: FaceMatch[];
}
export interface Library {
  storedPhotoCount?: number;
  capacityMode?: 'metered' | 'development';
  photos: Photo[];
  events: GalleryEvent[];
  jobs: ImportJob[];
  scans?: DiscoverScan[];
  photoLimit: number;
}
export interface Capabilities {
  folderSync?: boolean;
  folderSyncManagement?: boolean;
  cloudImports?: boolean;
  eventIndexMax?: number;
  durableDiscover?: boolean;
  discoverJobLimit?: number;
  storage: boolean;
  drive: boolean;
  driveOAuth: boolean;
  driveConnected: boolean;
  photoLimit: number;
  maxUploadBytes: number;
  billing: boolean;
  faceMatching: boolean;
  faceProvider: 'aws-rekognition' | null;
  faceIndexMax: number;
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: 'include',
      ...options,
      headers: {
        ...(options.body && typeof options.body === 'string'
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new HttpError(
      0,
      'Cannot reach PicFind. Check your connection and try again.',
    );
  }
  if (!response.ok) {
    const result = (await response.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
    } | null;
    throw new HttpError(
      response.status,
      result?.error?.message ??
        (response.status >= 500
          ? 'PicFind is temporarily unavailable. Please retry in a moment.'
          : 'This request could not be completed. Please try again.'),
      result?.error?.code,
    );
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}
export async function session() {
  try {
    return (await api<{ user: User }>('/auth/session')).user;
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) return null;
    throw error;
  }
}
export function saveFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
export const fileUrl = (photoId: string, eventId?: string) =>
  eventId
    ? `/api/public/events/${eventId}/photos/${photoId}`
    : `/api/photos/${photoId}/file`;
