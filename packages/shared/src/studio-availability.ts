import { z } from 'zod';
import {
  appointmentZone,
  localMinute,
  validScheduleInterval,
} from './studio-appointments.js';

export const AVAILABILITY_LIMIT = 100;
export const AVAILABILITY_RECOVERY_LIMIT = 500;
export const AVAILABILITY_ACTOR = 'X-PicFind-Studio-Actor';
const raw = z
  .object({
    title: z.string().trim().min(1).max(120),
    note: z.string().trim().max(1000),
    startLocal: localMinute,
    endLocal: localMinute,
    timeZone: appointmentZone,
    startAt: z.iso.datetime(),
    endAt: z.iso.datetime(),
    active: z.boolean(),
  })
  .strict();
const interval = (value: z.infer<typeof raw>) =>
  validScheduleInterval(value, 31);
export const availabilityFields = raw.refine(
  interval,
  'Choose valid timezone occurrences and an interval of at most 31 days.',
);
export type AvailabilityFields = z.infer<typeof availabilityFields>;
export const availabilityWrite = raw
  .extend({
    generation: z.uuid(),
    version: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict()
  .refine(interval);
export const availabilityIdentity = z
  .object({
    generation: z.uuid(),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const savedAvailability = raw
  .extend({
    id: z.uuid(),
    generation: z.uuid(),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .refine(interval)
  .refine((v) => Date.parse(v.createdAt) <= Date.parse(v.updatedAt));
export type SavedAvailability = z.infer<typeof savedAvailability>;
export const availabilityResponse = z
  .object({
    accountId: z.string().min(1),
    block: savedAvailability,
  })
  .strict();
export const availabilityDirectory = z
  .object({
    accountId: z.string().min(1),
    limit: z.literal(AVAILABILITY_LIMIT),
    blocks: z.array(savedAvailability).max(AVAILABILITY_RECOVERY_LIMIT),
  })
  .strict()
  .refine((v) => new Set(v.blocks.map((b) => b.id)).size === v.blocks.length);
export function blockFields(value: SavedAvailability): AvailabilityFields {
  return availabilityFields.parse(
    Object.fromEntries(
      Object.keys(raw.shape).map((key) => [
        key,
        value[key as keyof AvailabilityFields],
      ]),
    ),
  );
}
export function onlyDeactivates(
  current: SavedAvailability,
  fields: AvailabilityFields,
) {
  return (
    !fields.active &&
    (Object.keys(raw.shape) as (keyof AvailabilityFields)[]).every(
      (key) => key === 'active' || current[key] === fields[key],
    )
  );
}
