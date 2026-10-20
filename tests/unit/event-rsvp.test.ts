import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  guestRsvpSnapshot,
  hostRsvpSnapshot,
  publicRsvp,
  rsvpFields,
  rsvpTotals,
  rsvpWrite,
  storedRsvp,
  type RsvpView,
} from '../../packages/shared/src/event-rsvp';

const base = (): RsvpView => ({
  id: randomUUID(),
  displayName: 'Guest',
  response: 'going',
  partySize: 2,
  message: 'Use this response only for planning.',
  version: 1,
  invitationRevision: 1,
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
});
describe('private event RSVP contracts', () => {
  it('requires valid response sizes and explicit consent for writes', () => {
    const fields = {
      displayName: ' Guest ',
      response: 'going',
      partySize: 2,
      message: '',
    };
    expect(rsvpFields.parse(fields).displayName).toBe('Guest');
    for (const patch of [
      { partySize: 0 },
      { partySize: 11 },
      { partySize: 1.5 },
      { displayName: '' },
      { message: 'x'.repeat(301) },
      { response: 'not-going', partySize: 2 },
    ]) {
      expect(rsvpFields.safeParse({ ...fields, ...patch }).success).toBe(false);
    }
    expect(
      rsvpFields.safeParse({ ...fields, response: 'not-going', partySize: 0 })
        .success,
    ).toBe(true);
    const command = {
      ...fields,
      version: 0,
      receiptId: randomUUID(),
      invitationRevision: 1,
    };
    expect(rsvpWrite.safeParse(command).success).toBe(false);
    expect(
      rsvpWrite.safeParse({ ...command, consent: 'event-rsvp-v1' }).success,
    ).toBe(true);
    expect(
      rsvpWrite.safeParse({
        ...command,
        consent: 'event-rsvp-v1',
        ownerId: 'other',
      }).success,
    ).toBe(false);
  });
  it('projects private receipt hashes and retry digests out of response views', () => {
    const stored = storedRsvp.parse({
      ...base(),
      receiptHash: 'a'.repeat(64),
      commandDigest: 'b'.repeat(64),
      consent: 'event-rsvp-v1',
    });
    expect(publicRsvp(stored)).not.toHaveProperty('receiptHash');
    expect(publicRsvp(stored)).not.toHaveProperty('commandDigest');
    expect(publicRsvp(stored)).not.toHaveProperty('consent');
    expect(
      storedRsvp.safeParse({ ...stored, updatedAt: '2026-10-19T00:00:00.000Z' })
        .success,
    ).toBe(false);
  });
  it('counts reported responses and party sizes separately without counting declines as attendees', () => {
    expect(
      rsvpTotals([
        base(),
        { ...base(), response: 'maybe', partySize: 3 },
        { ...base(), response: 'not-going', partySize: 0 },
      ]),
    ).toEqual({
      responses: 3,
      going: 1,
      maybe: 1,
      notGoing: 1,
      goingParty: 2,
      maybeParty: 3,
    });
    expect(rsvpTotals([])).toEqual({
      responses: 0,
      going: 0,
      maybe: 0,
      notGoing: 0,
      goingParty: 0,
      maybeParty: 0,
    });
  });
  it('rejects mismatched browser receipts and duplicate owner response projections', () => {
    const row = base(),
      eventId = randomUUID(),
      policy = { enabled: true, closesAt: null, maxPartySize: 5 };
    const guest = {
      eventId,
      receiptId: row.id,
      invitationRevision: 1,
      accepting: true,
      policy,
      response: row,
    };
    expect(guestRsvpSnapshot.safeParse(guest).success).toBe(true);
    expect(
      guestRsvpSnapshot.safeParse({ ...guest, receiptId: randomUUID() })
        .success,
    ).toBe(false);
    expect(
      guestRsvpSnapshot.safeParse({ ...guest, invitationRevision: 0 }).success,
    ).toBe(false);
    const host = {
      accountId: 'owner',
      eventId,
      editable: true,
      accepting: true,
      settings: { ...policy, version: 1, updatedAt: row.updatedAt },
      responses: [row],
      limit: 300,
    };
    expect(hostRsvpSnapshot.safeParse(host).success).toBe(true);
    expect(
      hostRsvpSnapshot.safeParse({ ...host, responses: [row, row] }).success,
    ).toBe(false);
  });
});
