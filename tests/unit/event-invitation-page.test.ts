import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  blankInvitationPage,
  invitationPageCommand,
  invitationPageFields,
  invitationPageSnapshot,
  publicInvitationPage,
  storedInvitationPage,
} from '../../packages/shared/src/event-invitation-page';

describe('event invitation publication contracts', () => {
  const fields = {
    ...blankInvitationPage(),
    heading: 'Wedding celebration',
    date: '2026-11-01',
  };
  const stored = () => ({
    draft: fields,
    published: { fields, revision: 1, publishedAt: '2026-10-20T10:00:00.000Z' },
    version: 1,
    updatedAt: '2026-10-20T10:00:00.000Z',
    commandDigest: 'a'.repeat(64),
  });
  it('allows an unpublished blank draft but requires a date for publication', () => {
    expect(
      invitationPageCommand.safeParse({
        version: 0,
        action: 'save',
        fields: blankInvitationPage(),
      }).success,
    ).toBe(true);
    expect(
      invitationPageCommand.safeParse({
        version: 0,
        action: 'publish',
        fields: blankInvitationPage(),
      }).success,
    ).toBe(false);
    expect(
      invitationPageCommand.safeParse({ version: 0, action: 'publish', fields })
        .success,
    ).toBe(true);
    expect(
      invitationPageCommand.safeParse({ version: 0, action: 'delete', fields })
        .success,
    ).toBe(false);
  });
  it('validates calendar dates, IANA zones, local clock times and nonexistent DST times', () => {
    for (const changes of [
      { date: '2026-02-30' },
      { date: '1999-12-31' },
      { date: '2101-01-01' },
      { time: '24:00' },
      { time: '12:60' },
      { timeZone: 'Invented/Zone' },
      { date: '', time: '12:00' },
      { date: '2026-03-08', time: '02:30', timeZone: 'America/New_York' },
    ])
      expect(
        invitationPageFields.safeParse({ ...fields, ...changes }).success,
      ).toBe(false);
    expect(
      invitationPageFields.safeParse({
        ...fields,
        time: '01:30',
        timeZone: 'America/New_York',
      }).success,
    ).toBe(true);
  });
  it('bounds fields and themes without interpreting markup or permitting extra fields', () => {
    for (const changes of [
      { heading: '' },
      { host: 'x'.repeat(101) },
      { venue: 'x'.repeat(151) },
      { address: 'x'.repeat(301) },
      { instructions: 'x'.repeat(1001) },
      { theme: 'url(javascript:alert(1))' },
      { photoIds: [] },
    ])
      expect(
        invitationPageFields.safeParse({ ...fields, ...changes }).success,
      ).toBe(false);
    expect(
      invitationPageFields.parse({
        ...fields,
        instructions: ' <script>alert(1)</script> ',
      }).instructions,
    ).toBe('<script>alert(1)</script>');
  });
  it('bounds the combined UTF-8 payload and rejects inconsistent publication revisions and timestamps', () => {
    expect(storedInvitationPage.safeParse(stored()).success).toBe(true);
    const oversized = {
      ...fields,
      heading: '界'.repeat(120),
      host: '界'.repeat(100),
      venue: '界'.repeat(150),
      address: '界'.repeat(300),
      instructions: '\\'.repeat(1000),
    };
    expect(invitationPageFields.safeParse(oversized).success).toBe(true);
    const row = stored();
    expect(
      storedInvitationPage.safeParse({
        ...row,
        draft: oversized,
        published: { ...row.published, fields: oversized },
      }).success,
    ).toBe(true);
    const fourByte = { ...oversized, instructions: '\u0000'.repeat(1000) };
    expect(
      storedInvitationPage.safeParse({
        ...row,
        draft: fourByte,
        published: { ...row.published, fields: fourByte },
      }).success,
    ).toBe(false);
    expect(
      storedInvitationPage.safeParse({
        ...row,
        published: { ...row.published, revision: 2 },
      }).success,
    ).toBe(false);
    expect(
      storedInvitationPage.safeParse({
        ...row,
        updatedAt: '2026-10-19T10:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      storedInvitationPage.safeParse({ ...row, commandDigest: 'invalid' })
        .success,
    ).toBe(false);
  });
  it('keeps owner snapshots and public projection strictly distinct', () => {
    const row = stored(),
      eventId = randomUUID();
    const publicValue = { eventId, ...row.published };
    expect(publicInvitationPage.safeParse(publicValue).success).toBe(true);
    expect(
      publicInvitationPage.safeParse({ ...publicValue, draft: fields }).success,
    ).toBe(false);
    const page = {
      draft: blankInvitationPage(),
      published: null,
      version: 0,
      updatedAt: null,
    };
    expect(
      invitationPageSnapshot.safeParse({
        accountId: 'owner',
        eventId,
        editable: true,
        page,
      }).success,
    ).toBe(true);
    expect(
      invitationPageSnapshot.safeParse({
        accountId: 'owner',
        eventId,
        editable: true,
        page: { ...page, published: row.published },
      }).success,
    ).toBe(false);
  });
});
