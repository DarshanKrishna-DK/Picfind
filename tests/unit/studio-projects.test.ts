import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  advanceProject,
  blankProject,
  projectWrite,
  savedProject,
  projectView,
  type SavedProject,
} from '../../packages/shared/src/studio-projects';
const at = '2026-10-20T10:00:00.000Z';
describe('private project stages and bounded history', () => {
  it('retains creation time and distinguishes metadata updates from stage changes', () => {
    const fields = { ...blankProject(), name: 'Portrait session' };
    const first = advanceProject(null, randomUUID(), fields, '', 'owner', at);
    const metadata = advanceProject(
      first,
      first.id,
      { ...fields, summary: 'Private brief' },
      '',
      'owner',
      '2026-10-21T10:00:00.000Z',
    );
    expect(metadata).toMatchObject({
      version: 2,
      transitionCount: 1,
      createdAt: at,
      updatedAt: '2026-10-21T10:00:00.000Z',
    });
    const editing = advanceProject(
      metadata,
      first.id,
      { ...fields, stage: 'editing' },
      'Culling complete',
      'owner',
      '2026-10-22T10:00:00.000Z',
    );
    expect(editing.transitions.at(-1)).toMatchObject({
      sequence: 2,
      from: 'inquiry',
      to: 'editing',
      reason: 'Culling complete',
      actorId: 'owner',
    });
  });
  it('requires reasons for backward movement and archive restoration', () => {
    const first = advanceProject(
      null,
      randomUUID(),
      { ...blankProject(), name: 'Session', stage: 'archived' },
      '',
      'owner',
      at,
    );
    expect(() =>
      advanceProject(
        first,
        first.id,
        { ...first, stage: 'editing' },
        '',
        'owner',
        at,
      ),
    ).toThrow(/reason/);
    const restored = advanceProject(
      first,
      first.id,
      {
        name: first.name,
        summary: first.summary,
        clientId: first.clientId,
        eventIds: first.eventIds,
        stage: 'editing',
      },
      'Client requested a new crop',
      'owner',
      at,
    );
    expect(restored.stage).toBe('editing');
    expect(restored.transitions).toHaveLength(2);
  });
  it('keeps a bounded, contiguous recent history and reports omitted transitions', () => {
    let current: SavedProject | null = null;
    const id = randomUUID();
    for (let index = 0; index < 80; index++)
      current = advanceProject(
        current,
        id,
        {
          ...blankProject(),
          name: 'Session',
          summary: '写真'.repeat(500),
          stage: index % 2 ? 'editing' : 'shooting',
        },
        '写真'.repeat(80),
        'owner',
        at,
      );
    expect(current!.transitionCount).toBe(80);
    expect(current!.transitions.length).toBeGreaterThan(1);
    expect(current!.transitions.length).toBeLessThanOrEqual(30);
    expect(current!.transitions[0]!.sequence).toBe(
      81 - current!.transitions.length,
    );
    expect(current!.transitions.at(-1)!.sequence).toBe(80);
    expect(
      new TextEncoder().encode(JSON.stringify(current)).length,
    ).toBeLessThanOrEqual(11_000);
    expect(savedProject.safeParse(current).success).toBe(true);
  });
  it('rejects inconsistent history, duplicate event links and injected system fields', () => {
    const current = advanceProject(
      null,
      randomUUID(),
      { ...blankProject(), name: 'Session' },
      '',
      'owner',
      at,
    );
    expect(
      savedProject.safeParse({ ...current, stage: 'delivered' }).success,
    ).toBe(false);
    expect(
      savedProject.safeParse({ ...current, transitionCount: 2 }).success,
    ).toBe(false);
    expect(
      savedProject.safeParse({
        ...current,
        updatedAt: '2020-01-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
    const id = randomUUID();
    expect(
      projectWrite.safeParse({
        ...blankProject(),
        name: 'Session',
        eventIds: [id, id],
        reason: '',
        version: 0,
      }).success,
    ).toBe(false);
    expect(projectWrite.safeParse({ ...current, reason: '' }).success).toBe(
      false,
    );
    expect(
      projectView.safeParse({
        project: current,
        client: null,
        events: [{ id, title: 'Unexpected link' }],
      }).success,
    ).toBe(false);
  });
});
