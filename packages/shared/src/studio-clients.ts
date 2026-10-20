import { z } from 'zod';

export const MAX_STUDIO_CLIENTS = 200;
const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(/^[^\p{Cc}]*$/u, 'Use a single line of text.');
export const clientFields = z
  .object({
    name: line(100).min(1),
    email: z
      .string()
      .trim()
      .max(254)
      .refine((value) => !value || z.email().safeParse(value).success)
      .transform((value) => value.toLowerCase()),
    phone: line(40),
    company: line(100),
  })
  .strict();
export const clientVersion = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
export const savedClient = clientFields
  .extend({
    id: z.uuid(),
    version: clientVersion.min(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const clientDirectory = z
  .object({
    accountId: z.string().min(1),
    limit: z.literal(MAX_STUDIO_CLIENTS),
    totalCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    clients: z.array(savedClient).max(MAX_STUDIO_CLIENTS),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.clients.map((client) => client.id)).size ===
        value.clients.length &&
      value.clients.length === Math.min(value.totalCount, value.limit),
  );
export type ClientFields = z.infer<typeof clientFields>;
export type SavedClient = z.infer<typeof savedClient>;
export type ClientDirectory = z.infer<typeof clientDirectory>;
export const blankClient = (): ClientFields => ({
  name: '',
  email: '',
  phone: '',
  company: '',
});
export function sameClientFields(a: ClientFields, b: ClientFields) {
  return (
    a.name === b.name &&
    a.email === b.email &&
    a.phone === b.phone &&
    a.company === b.company
  );
}
export function clientDirectoryCsv(clients: SavedClient[]) {
  const checked = z.array(savedClient).max(MAX_STUDIO_CLIENTS).parse(clients);
  function cell(value: string) {
    const safe = /^\s*[=+\-@]/u.test(value) ? `'${value}` : value;
    return `"${safe.replaceAll('"', '""')}"`;
  }
  return (
    [
      ['Client ID', 'Name', 'Email', 'Phone', 'Company'],
      ...checked.map((client) => [
        client.id,
        client.name,
        client.email,
        client.phone,
        client.company,
      ]),
    ]
      .map((row) => row.map(cell).join(','))
      .join('\r\n') + '\r\n'
  );
}
