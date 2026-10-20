import { randomUUID } from 'node:crypto';
import { questionnaireFixture } from './questionnaires';
import {
  blankService,
  type ServiceFields,
} from '../../packages/shared/src/studio-services';
export function serviceFixture() {
  const f = questionnaireFixture(),
    serviceId = randomUUID(),
    root = '/api/studio/services';
  const fields: ServiceFields = {
    ...blankService(),
    title: 'Event portraits',
    description: 'A private package.',
    deliverables: ['Two hours of coverage', '40 edited JPEG files'],
    durationMinutes: 120,
    pricingMode: 'starting',
    currency: 'INR',
    amountMinor: 250000,
  };
  const save = (
    changes: object = {},
    version = 0,
    id: string = serviceId,
    actor = f.ownerId,
  ) => f.put(`${root}/${id}`, { ...fields, ...changes, version }, actor);
  return { ...f, serviceId, root, fields, save };
}
