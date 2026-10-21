import { randomUUID } from 'node:crypto';
import { questionnaireFixture } from './questionnaires';
import { advanceMilestone } from '../../packages/shared/src/studio-milestones';
import { savedAppointment } from '../../packages/shared/src/studio-appointments';
import { BRIEF_ACTOR } from '../../packages/shared/src/project-brief';
export function briefFixture() {
  const f = questionnaireFixture(),
    eventId = randomUUID(),
    foreignEventId = randomUUID(),
    milestoneId = randomUUID(),
    appointmentId = randomUUID();
  const createdAt = f.records.get(f.projectId)!.createdAt;
  f.records.get(f.projectId)!.studioProject!.eventIds = [
    eventId,
    foreignEventId,
  ];
  f.records.get(f.projectId)!.studioProject!.summary =
    'Private project instructions';
  for (const [id, ownerId, title] of [
    [eventId, f.ownerId, 'Portrait gallery'],
    [foreignEventId, f.strangerId, 'Confidential foreign title'],
  ] as const) {
    f.records.set(id, {
      id,
      ownerId,
      kind: 'event',
      createdAt,
      title,
      description: 'Private event description',
      passcodeHash: 'secret-passcode-hash',
    });
  }
  const milestone = advanceMilestone(
    null,
    milestoneId,
    {
      projectId: f.projectId,
      title: 'Deliver edited portraits',
      note: 'Private milestone note',
      dueDate: '2026-12-01',
      timeZone: 'Asia/Kolkata',
      status: 'open',
    },
    createdAt,
  );
  f.records.set(milestoneId, {
    id: milestoneId,
    ownerId: f.ownerId,
    kind: 'job',
    purpose: 'studio-milestone',
    createdAt,
    studioMilestone: milestone,
    milestoneCommandDigest: 'b'.repeat(64),
  });
  const appointment = savedAppointment.parse({
    id: appointmentId,
    projectId: f.projectId,
    title: 'Portrait shoot',
    note: 'Private appointment note',
    startLocal: '2026-11-01T10:00',
    endLocal: '2026-11-01T11:00',
    timeZone: 'UTC',
    startAt: '2026-11-01T10:00:00.000Z',
    endAt: '2026-11-01T11:00:00.000Z',
    status: 'scheduled',
    version: 1,
    createdAt,
    updatedAt: createdAt,
  });
  f.records.set(appointmentId, {
    id: appointmentId,
    ownerId: f.ownerId,
    kind: 'job',
    purpose: 'studio-appointment',
    createdAt,
    studioAppointment: appointment,
    appointmentCommandDigest: 'c'.repeat(64),
  });
  const briefRoot = `/api/studio/projects/${f.projectId}/brief`;
  const brief = (notes = 'omit', actor = f.ownerId) =>
    f.read(`${briefRoot}?notes=${notes}`, actor).set(BRIEF_ACTOR, actor);
  return {
    ...f,
    eventId,
    foreignEventId,
    milestoneId,
    appointmentId,
    briefRoot,
    brief,
  };
}
