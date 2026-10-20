import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  advanceMilestone,
  dateInZone,
  isMilestoneOverdue,
  milestoneFields,
  savedMilestone,
  workQueue,
} from '../../packages/shared/src/studio-milestones';

const fields = {
  projectId: randomUUID(),
  title: 'Deliver proofs',
  note: '',
  dueDate: '2026-03-08',
  timeZone: 'America/New_York',
  status: 'open' as const,
};
describe('calendar deadlines and milestone lifecycle', () => {
  it('preserves chronological timestamps during clock rollback and accepts equivalent ISO precision', () => {
    const id = randomUUID();
    const first = advanceMilestone(
      null,
      id,
      { ...fields, status: 'completed' },
      '2026-03-02T00:00:00Z',
    );
    const changed = advanceMilestone(
      first,
      id,
      { ...fields, status: 'completed', title: 'Revised' },
      '2026-03-01T23:59:00Z',
    );
    expect(changed.updatedAt).toBe(first.updatedAt);
    expect(changed.completedAt).toBe(first.completedAt);
    expect(changed.version).toBe(2);
    const reopened = advanceMilestone(
      changed,
      id,
      fields,
      '2026-03-01T23:59:30Z',
    );
    const finished = advanceMilestone(
      reopened,
      id,
      { ...fields, status: 'completed' },
      '2026-03-01T23:59:40Z',
    );
    expect(finished.completedAt).toBe(first.updatedAt);
    expect(finished.version).toBe(4);
    expect(
      savedMilestone.safeParse({ ...first, createdAt: '2026-03-02T00:00:00Z' })
        .success,
    ).toBe(true);
  });
  it('keeps the whole spring DST calendar day due and crosses midnight correctly', () => {
    const milestone = advanceMilestone(
      null,
      randomUUID(),
      fields,
      '2026-03-01T00:00:00.000Z',
    );
    const view = {
      milestone,
      project: {
        id: fields.projectId,
        name: 'Wedding',
        stage: 'editing' as const,
      },
    };
    expect(dateInZone(new Date('2026-03-09T03:59:59Z'), fields.timeZone)).toBe(
      '2026-03-08',
    );
    expect(isMilestoneOverdue(view, new Date('2026-03-09T03:59:59Z'))).toBe(
      false,
    );
    expect(isMilestoneOverdue(view, new Date('2026-03-09T04:00:00Z'))).toBe(
      true,
    );
    expect(
      isMilestoneOverdue({ ...view, project: null }, new Date('2027-01-01Z')),
    ).toBe(false);
    expect(
      isMilestoneOverdue(
        { ...view, project: { ...view.project, stage: 'archived' } },
        new Date('2027-01-01Z'),
      ),
    ).toBe(false);
  });
  it('handles the repeated fall hour, fractional offsets and opposite sides of midnight', () => {
    expect(
      dateInZone(new Date('2026-11-02T04:59:59Z'), 'America/New_York'),
    ).toBe('2026-11-01');
    expect(
      dateInZone(new Date('2026-11-02T05:00:00Z'), 'America/New_York'),
    ).toBe('2026-11-02');
    expect(dateInZone(new Date('2026-10-20T18:29:59Z'), 'Asia/Kolkata')).toBe(
      '2026-10-20',
    );
    expect(dateInZone(new Date('2026-10-20T18:30:00Z'), 'Asia/Kolkata')).toBe(
      '2026-10-21',
    );
    expect(
      dateInZone(new Date('2026-10-20T18:30:00Z'), 'America/Los_Angeles'),
    ).toBe('2026-10-20');
  });
  it.each([
    '2026-02-29',
    '2024-02-30',
    '2026-13-01',
    '2026-1-01',
    '2026-04-31',
  ])('rejects invalid calendar date %s', (dueDate) => {
    expect(milestoneFields.safeParse({ ...fields, dueDate }).success).toBe(
      false,
    );
  });
  it('accepts leap days and rejects unknown zones and injected system fields', () => {
    expect(
      milestoneFields.safeParse({ ...fields, dueDate: '2024-02-29' }).success,
    ).toBe(true);
    expect(
      milestoneFields.safeParse({ ...fields, timeZone: 'Mars/Base' }).success,
    ).toBe(false);
    expect(
      milestoneFields.safeParse({ ...fields, timeZone: '+05:30' }).success,
    ).toBe(false);
    expect(
      milestoneFields.safeParse({ ...fields, ownerId: 'other' }).success,
    ).toBe(false);
  });
  it('preserves completion through edits and gives a new time only after reopening', () => {
    const id = randomUUID(),
      start = '2026-03-01T00:00:00.000Z',
      finish = '2026-03-02T00:00:00.000Z';
    const first = advanceMilestone(null, id, fields, start);
    const completed = advanceMilestone(
      first,
      id,
      { ...fields, status: 'completed' },
      finish,
    );
    const edited = advanceMilestone(
      completed,
      id,
      { ...fields, title: 'Final proofs', status: 'completed' },
      '2026-03-03T00:00:00.000Z',
    );
    expect(edited.completedAt).toBe(finish);
    expect(edited.createdAt).toBe(start);
    const reopened = advanceMilestone(
      edited,
      id,
      fields,
      '2026-03-04T00:00:00.000Z',
    );
    expect(reopened.completedAt).toBeNull();
    expect(
      advanceMilestone(
        reopened,
        id,
        { ...fields, status: 'completed' },
        '2026-03-05T00:00:00.000Z',
      ).completedAt,
    ).toBe('2026-03-05T00:00:00.000Z');
    expect(
      savedMilestone.safeParse({ ...completed, completedAt: null }).success,
    ).toBe(false);
    expect(
      savedMilestone.safeParse({ ...first, completedAt: finish }).success,
    ).toBe(false);
    expect(
      savedMilestone.safeParse({
        ...completed,
        completedAt: '2025-01-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
  it('rejects mismatched project projections and duplicate task IDs', () => {
    const milestone = advanceMilestone(
      null,
      randomUUID(),
      fields,
      '2026-03-01T00:00:00.000Z',
    );
    const queue = {
      accountId: 'owner',
      limit: 300,
      totalCount: 1,
      projects: [],
      milestones: [{ milestone, project: null }],
    };
    expect(workQueue.safeParse(queue).success).toBe(true);
    expect(
      workQueue.safeParse({
        ...queue,
        milestones: [
          {
            milestone,
            project: { id: randomUUID(), name: 'Other', stage: 'editing' },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      workQueue.safeParse({
        ...queue,
        totalCount: 2,
        milestones: [queue.milestones[0], queue.milestones[0]],
      }).success,
    ).toBe(false);
  });
});
