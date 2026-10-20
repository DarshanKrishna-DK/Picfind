import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { questionnaireFixture, questionnaireOrigin } from './questionnaires';
import { enquiryFormId } from '../../apps/api/src/studio-enquiries';
import { ENQUIRY_CONSENT } from '../../packages/shared/src/studio-enquiries';

export function enquiryFixture() {
  const f = questionnaireFixture(),
    formId = enquiryFormId(f.ownerId),
    enquiryId = randomUUID();
  const formFields = {
    name: 'Asha Studio',
    introduction: 'Tell us about your session.',
    enabled: true,
  };
  const contact = {
    name: 'Synthetic Client',
    email: 'client@example.test',
    phone: '+91 9000000000',
    date: '2026-12-01',
    sessionType: 'Event portraits',
    message: 'Private session requirements.',
  };
  const publicPath = `/api/public/enquiries/${formId}`;
  const publish = (changes: object = {}, version = 0, actor = f.ownerId) =>
    f.put(
      '/api/studio/enquiry-form',
      { ...formFields, ...changes, version },
      actor,
    );
  const submit = (changes: object = {}, id = enquiryId) =>
    request(f.app)
      .put(`${publicPath}/${id}`)
      .set('Origin', questionnaireOrigin)
      .send({
        ...contact,
        formVersion: 1,
        consent: ENQUIRY_CONSENT,
        ...changes,
      });
  const update = (changes: object = {}, version = 1, actor = f.ownerId) =>
    request(f.app)
      .patch(`/api/studio/enquiries/${enquiryId}`)
      .set('Origin', questionnaireOrigin)
      .set('Cookie', `picfind_session=${actor}`)
      .send({
        version,
        stage: 'contacted',
        note: 'Private follow-up note.',
        ...changes,
      });
  return {
    ...f,
    formId,
    enquiryId,
    formFields,
    contact,
    publicPath,
    publish,
    submit,
    update,
  };
}
