import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { creditFixture } from './credit-presets';
import { questionnaireOrigin } from './questionnaires';
import {
  SPONSOR_ACTOR,
  SPONSOR_PERMISSION,
} from '../../packages/shared/src/event-sponsors';
import { sponsorRecordId } from '../../apps/api/src/event-sponsors';

export async function sponsorFixture() {
  const f = creditFixture();
  const fields = {
    gallery: true,
    wall: true,
    placements: [
      {
        id: randomUUID(),
        name: 'Community Camera',
        caption: 'Supporting local photographers',
        website: 'https://example.test/community',
      },
    ],
  };
  const root = `/api/events/${f.eventId}/sponsors`;
  const id = sponsorRecordId(f.eventId);
  await request(f.app)
    .patch(`/api/events/${f.eventId}/highlights`)
    .set('Cookie', `picfind_session=${f.ownerId}`)
    .set('Origin', questionnaireOrigin)
    .send({
      title: 'Selected portraits',
      photoIds: f.photos.map((row) => row.id),
      published: true,
      version: 0,
    })
    .expect(200);
  const write = (body: object, actor = f.ownerId, expected = actor) =>
    request(f.app)
      .put(root)
      .set('Cookie', `picfind_session=${actor}`)
      .set('Origin', questionnaireOrigin)
      .set(SPONSOR_ACTOR, expected)
      .send(body);
  const save = (changes: object = {}) =>
    write({ action: 'save', version: 0, fields, ...changes });
  const publish = (changes: object = {}) =>
    write({
      action: 'publish',
      version: 0,
      fields,
      permission: SPONSOR_PERMISSION,
      ...changes,
    });
  const withdraw = (version: number) => write({ action: 'withdraw', version });
  const publicRead = () =>
    f.read(`/api/public/highlights/${f.eventId}`, f.clientId);
  return {
    ...f,
    sponsorFields: fields,
    root,
    id,
    write,
    save,
    publish,
    withdraw,
    publicRead,
    stored: () => f.records.get(id)!,
  };
}
