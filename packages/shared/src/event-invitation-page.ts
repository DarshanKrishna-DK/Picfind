import { z } from 'zod';
import {
  appointmentOccurrences,
  appointmentZone,
} from './studio-appointments.js';

export const invitationPageFields = z
  .object({
    heading: z.string().trim().min(1).max(120),
    host: z.string().trim().max(100),
    date: z.union([
      z.literal(''),
      z.iso
        .date()
        .refine((value) => value >= '2000-01-01' && value <= '2100-12-31'),
    ]),
    time: z.union([
      z.literal(''),
      z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    ]),
    timeZone: appointmentZone,
    venue: z.string().trim().max(150),
    address: z.string().trim().max(300),
    instructions: z.string().trim().max(1000),
    theme: z.enum(['linen', 'forest', 'midnight']),
  })
  .strict()
  .refine(
    (value) =>
      !value.time ||
      (!!value.date &&
        appointmentOccurrences(`${value.date}T${value.time}`, value.timeZone)
          .length > 0),
  );
export type InvitationPageFields = z.infer<typeof invitationPageFields>;
export const blankInvitationPage = (): InvitationPageFields => ({
  heading: 'Event invitation',
  host: '',
  date: '',
  time: '',
  timeZone: 'UTC',
  venue: '',
  address: '',
  instructions: '',
  theme: 'linen',
});
export const invitationPageCommand = z
  .object({
    version: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 2),
    action: z.enum(['save', 'publish', 'withdraw']),
    fields: invitationPageFields,
  })
  .strict()
  .refine((value) => value.action !== 'publish' || !!value.fields.date);
const publication = z
  .object({
    fields: invitationPageFields.refine((value) => !!value.date),
    revision: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    publishedAt: z.iso.datetime(),
  })
  .strict();
export const storedInvitationPage = z
  .object({
    draft: invitationPageFields,
    published: publication.nullable(),
    version: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    updatedAt: z.iso.datetime(),
    commandDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine(
    (value) =>
      (!value.published ||
        (value.published.revision <= value.version &&
          Date.parse(value.published.publishedAt) <=
            Date.parse(value.updatedAt))) &&
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= 12_000,
  );
export type StoredInvitationPage = z.infer<typeof storedInvitationPage>;
export const invitationPageState = z
  .object({
    draft: invitationPageFields,
    published: publication.nullable(),
    version: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    updatedAt: z.iso.datetime().nullable(),
  })
  .strict()
  .refine((value) =>
    value.version === 0
      ? value.updatedAt === null &&
        value.published === null &&
        JSON.stringify(value.draft) === JSON.stringify(blankInvitationPage())
      : value.updatedAt !== null &&
        (!value.published ||
          (value.published.revision <= value.version &&
            Date.parse(value.published.publishedAt) <=
              Date.parse(value.updatedAt))),
  );
export const invitationPageSnapshot = z
  .object({
    accountId: z.string().min(1),
    eventId: z.uuid(),
    editable: z.boolean(),
    page: invitationPageState,
  })
  .strict();
export type InvitationPageSnapshot = z.infer<typeof invitationPageSnapshot>;
export const publicInvitationPage = publication
  .extend({
    eventId: z.uuid(),
  })
  .strict();
export type PublicInvitationPage = z.infer<typeof publicInvitationPage>;
