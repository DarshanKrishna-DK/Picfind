import { z } from 'zod';

const origin = z.url().refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
});

export const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    HOST: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
    WEB_ORIGIN: origin.default('http://localhost:5173'),
    GOOGLE_OAUTH_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    APPWRITE_ENDPOINT: z.string().default(''),
    APPWRITE_PROJECT_ID: z.string().default(''),
    APPWRITE_API_KEY: z.string().default(''),
    FACE_PROVIDER: z
      .enum(['none', 'aws-rekognition', 'azure-face'])
      .default('none'),
    AWS_REGION: z.string().default(''),
    REKOGNITION_NAMESPACE: z
      .string()
      .regex(/^picfind-[a-z0-9-]{1,40}$/)
      .default('picfind-dev'),
    REKOGNITION_MATCH_THRESHOLD: z.coerce
      .number()
      .finite()
      .min(0)
      .max(100)
      .optional(),
    REKOGNITION_MAX_MATCHES: z.coerce
      .number()
      .int()
      .min(1)
      .max(4096)
      .default(50),
    FACE_INDEX_MAX: z.coerce.number().int().min(1).max(100).default(20),
    GOOGLE_DRIVE_CLIENT_ID: z.string().default(''),
    GOOGLE_DRIVE_CLIENT_SECRET: z.string().default(''),
  })
  .superRefine((value, context) => {
    if (value.APPWRITE_API_KEY) {
      const endpoint = z.url().safeParse(value.APPWRITE_ENDPOINT);
      if (
        !endpoint.success ||
        new URL(endpoint.data).protocol !== 'https:' ||
        !value.APPWRITE_PROJECT_ID
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Appwrite requires an HTTPS endpoint and project identifier.',
        });
      }
    }
    if (
      value.NODE_ENV === 'production' &&
      (!value.APPWRITE_API_KEY || !value.WEB_ORIGIN.startsWith('https://'))
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Production requires account configuration and an HTTPS website origin.',
      });
    }
    if (value.FACE_PROVIDER === 'azure-face') {
      context.addIssue({
        code: 'custom',
        message:
          'Azure Face Identify/Find Similar is Limited Access and is not enabled. Use FACE_PROVIDER=aws-rekognition.',
      });
    }
    if (value.FACE_PROVIDER === 'aws-rekognition') {
      if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(value.AWS_REGION)) {
        context.addIssue({
          code: 'custom',
          message:
            'FACE_PROVIDER=aws-rekognition requires AWS_REGION (for example ap-south-1).',
        });
      }
      if (value.REKOGNITION_MATCH_THRESHOLD === undefined) {
        context.addIssue({
          code: 'custom',
          message:
            'FACE_PROVIDER=aws-rekognition requires REKOGNITION_MATCH_THRESHOLD (0-100).',
        });
      }
    }
    if (
      Boolean(value.GOOGLE_DRIVE_CLIENT_ID) !==
      Boolean(value.GOOGLE_DRIVE_CLIENT_SECRET)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Google Drive OAuth requires both GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET.',
      });
    }
  });
