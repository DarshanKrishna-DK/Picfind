import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { questionnaireFixture, questionnaireOrigin } from './questionnaires';
import type { LibraryRecord } from '../../apps/api/src/library';

export function creditFixture() {
  const base = questionnaireFixture(),
    eventId = randomUUID(),
    presetId = randomUUID(),
    now = new Date().toISOString();
  base.records.set(eventId, {
    id: eventId,
    kind: 'event',
    ownerId: base.ownerId,
    title: 'Portrait gallery',
    createdAt: now,
    visibility: 'link',
  });
  const photos: LibraryRecord[] = Array.from({ length: 3 }, (_, index) => ({
    id: randomUUID(),
    kind: 'photo',
    ownerId: base.ownerId,
    eventId,
    filename: `portrait-${index + 1}.jpg`,
    createdAt: now,
    bytes: 12,
    width: 20,
    height: 20,
  }));
  photos.forEach((row) => base.records.set(row.id, row));
  const fields = {
    label: 'Main studio',
    name: 'Asha Photography',
    website: 'https://example.test/portfolio',
  };
  const root = '/api/studio/credit-presets';
  const save = (changes: object = {}, version = 0, actor = base.ownerId) =>
    base.put(`${root}/${presetId}`, { ...fields, ...changes, version }, actor);
  const preview = (
    ids = photos.map((row) => row.id),
    changes: object = {},
    actor = base.ownerId,
  ) =>
    request(base.app)
      .post('/api/photos/attribution-preview')
      .set('Cookie', `picfind_session=${actor}`)
      .set('Origin', questionnaireOrigin)
      .send({
        photoIds: ids,
        fields: {
          name: fields.name,
          website: fields.website,
          published: false,
          ...changes,
        },
      });
  const patch = (id: string, body: object, actor = base.ownerId) =>
    request(base.app)
      .patch(`/api/photos/${id}/attribution`)
      .set('Cookie', `picfind_session=${actor}`)
      .set('Origin', questionnaireOrigin)
      .send(body);
  return {
    ...base,
    eventId,
    photos,
    presetId,
    fields,
    presetRoot: root,
    save,
    preview,
    patch,
  };
}
