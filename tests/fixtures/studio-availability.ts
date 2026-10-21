import { randomUUID } from 'node:crypto';
import { questionnaireFixture } from './questionnaires';

export function availabilityFixture() {
  const f = questionnaireFixture(),
    id = randomUUID(),
    generation = randomUUID(),
    root = '/api/studio/availability',
    path = `${root}/${id}`;
  const fields = {
    title: 'Travel to venue',
    note: 'Private travel details',
    startLocal: '2026-11-01T10:00',
    endLocal: '2026-11-01T11:00',
    timeZone: 'UTC',
    startAt: '2026-11-01T10:00:00.000Z',
    endAt: '2026-11-01T11:00:00.000Z',
    active: true,
  };
  const command = { ...fields, generation, version: 0 };
  const appointment = {
    ...fields,
    projectId: f.projectId,
    status: 'scheduled',
    version: 0,
  };
  const { active: _active, ...appointmentFields } = appointment;
  void _active;
  return {
    ...f,
    id,
    generation,
    availabilityRoot: root,
    availabilityPath: path,
    blockFields: fields,
    command,
    appointmentFields,
    create: (changes: object = {}) => f.put(path, { ...command, ...changes }),
    appoint: (changes: object = {}, appointmentId: string = randomUUID()) =>
      f.put(`/api/studio/appointments/${appointmentId}`, {
        ...appointmentFields,
        ...changes,
      }),
  };
}
