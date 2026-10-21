import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { creditFixture } from './credit-presets';
import { questionnaireOrigin } from './questionnaires';
import { PREFLIGHT_ACTOR } from '../../packages/shared/src/upload-preflight';

export function preflightFixture() {
  const f = creditFixture();
  f.photos.forEach((photo, index) => {
    photo.uploadInputDigest = String(index + 1).repeat(64);
    f.records.set(photo.id, photo);
  });
  const items = [
    { id: randomUUID(), digest: f.photos[0]!.uploadInputDigest!, size: 120 },
    { id: randomUUID(), digest: 'a'.repeat(64), size: 240 },
  ];
  const command = {
    requestId: randomUUID(),
    eventId: f.eventId as string | null,
    items,
  };
  const inspect = (changes: object = {}, actor = f.ownerId, header = actor) =>
    request(f.app)
      .post('/api/photos/preflight')
      .set('Cookie', `picfind_session=${actor}`)
      .set('Origin', questionnaireOrigin)
      .set(PREFLIGHT_ACTOR, header)
      .send({ ...command, ...changes });
  return { ...f, items, command, inspect };
}
