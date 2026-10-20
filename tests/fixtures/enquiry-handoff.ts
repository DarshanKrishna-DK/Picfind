import { randomUUID } from 'node:crypto';
import { enquiryFixture } from './studio-enquiries';
import { handoffPreview } from '../../packages/shared/src/enquiry-handoff';
export async function handoffFixture() {
  const f = enquiryFixture();
  await f.publish().expect(200);
  await f.submit().expect(201);
  const root = `/api/studio/enquiries/${f.enquiryId}/handoff`;
  const initial = handoffPreview.parse((await f.read(root).expect(200)).body);
  const command = {
    action: 'start' as const,
    operationId: randomUUID(),
    version: initial.enquiry.version,
    sourceToken: initial.sourceToken,
    client: {
      mode: 'new' as const,
      id: randomUUID(),
      fields: {
        name: f.contact.name,
        email: f.contact.email,
        phone: f.contact.phone,
        company: '',
      },
    },
    project: {
      id: randomUUID(),
      name: 'Portrait project',
      summary: 'Owner-reviewed project details.',
    },
  };
  const start = (changes: object = {}, owner = f.ownerId) =>
    f.put(root, { ...command, ...changes }, owner);
  const current = async () =>
    handoffPreview.parse((await f.read(root).expect(200)).body);
  const resume = async () => {
    const value = await current();
    return f.put(root, {
      action: 'resume',
      operationId: value.handoff!.operationId,
      recoveryToken: value.recoveryToken,
      createMissing: Object.values(value.targets!)
        .filter((target) => target.mayCreate)
        .map((target) => target.id),
    });
  };
  return { ...f, root, initial, command, start, current, resume };
}
