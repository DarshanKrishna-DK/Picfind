import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { questionnaireFixture } from './questionnaires';
import { portfolioRecordId } from '../../apps/api/src/studio-portfolio';
import {
  blankPortfolio,
  PORTFOLIO_CONSENT,
} from '../../packages/shared/src/studio-portfolio';
import type { LibraryRecord } from '../../apps/api/src/library';

export async function portfolioFixture() {
  const f = questionnaireFixture();
  const jpeg = await sharp({
    create: { width: 64, height: 48, channels: 3, background: '#657f71' },
  })
    .jpeg()
    .toBuffer();
  const event: LibraryRecord = {
    id: randomUUID(),
    kind: 'event',
    ownerId: f.ownerId,
    title: 'Private portrait session',
    visibility: 'private',
    createdAt: new Date().toISOString(),
  };
  const photos: LibraryRecord[] = [0, 1, 2].map((index) => ({
    id: randomUUID(),
    kind: 'photo',
    ownerId: f.ownerId,
    eventId: event.id,
    filename: `Private-photo-${index}.jpg`,
    bytes: jpeg.length,
    width: 64,
    height: 48,
    createdAt: event.createdAt,
    privatePhotoNote: 'Private client note',
    faceIds: ['private-face-index'],
  }));
  for (const row of [event, ...photos]) f.records.set(row.id, row);
  f.store.file = async () => new Response(new Uint8Array(jpeg));
  f.store.removeFile = async () => {};
  const root = '/api/studio/portfolio',
    id = portfolioRecordId(f.ownerId);
  const publicUrl = `/api/public/portfolios/${id}`;
  const fields = {
    ...blankPortfolio(),
    name: 'Asha Photography',
    tagline: 'Portraits and celebrations',
    biography: 'Photographs with room to breathe.',
    location: 'Bengaluru',
    website: 'https://example.com/photographer',
    photos: photos.slice(0, 2).map((photo, index) => ({
      id: photo.id,
      caption: `Portrait ${index + 1}`,
    })),
  };
  const save = (changes: object = {}, owner = f.ownerId) =>
    f.put(
      root,
      { action: 'save', fields, version: 0, permission: null, ...changes },
      owner,
    );
  const publish = (version = 0) =>
    save({ action: 'publish', version, permission: PORTFOLIO_CONSENT });
  const publicRead = (path = publicUrl) => request(f.app).get(path);
  const media = (photoId = photos[0]!.id) =>
    publicRead(`${publicUrl}/photos/${photoId}`);
  const stored = () => f.records.get(id)!;
  return {
    ...f,
    jpeg,
    event,
    photos,
    root,
    id,
    publicUrl,
    fields,
    save,
    publish,
    publicRead,
    media,
    stored,
  };
}
