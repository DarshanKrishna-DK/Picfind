import { Router, type Request } from 'express';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ApiError } from './auth.js';
import { withAccountLock } from './locks.js';
import type { LibraryStore } from './library.js';
import { readStudioEnquiry } from './studio-enquiries.js';
import {
  ENQUIRY_REPORT_ACTOR,
  ENQUIRY_REPORT_LIMIT,
  blankEnquiryReportFilters,
  enquiryReportFilters,
  buildEnquiryReport,
} from '../../../packages/shared/src/enquiry-report.js';
export function createEnquiryReport(
  store: () => LibraryStore,
  owner: (req: Request) => Promise<string>,
) {
  const router = Router();
  router.get('/studio/enquiry-report', async (req, res) => {
    const actor = await owner(req);
    if (
      req.get(ENQUIRY_REPORT_ACTOR) &&
      req.get(ENQUIRY_REPORT_ACTOR) !== actor
    )
      throw new ApiError(
        403,
        'REPORT_ACCOUNT_CHANGED',
        'The signed-in account changed. Reload the enquiry report.',
      );
    const query = z.record(z.string(), z.string()).safeParse(req.query);
    const input = query.success
      ? enquiryReportFilters.safeParse({
          ...blankEnquiryReportFilters(),
          ...query.data,
        })
      : null;
    if (!input?.success)
      throw new ApiError(
        400,
        'INVALID_REPORT_FILTERS',
        'Choose valid report filters and an ordered received date range.',
      );
    const result = await withAccountLock(actor, async () => {
      const listed = await store().list(actor, 'job');
      if (listed.length > 2000)
        throw new ApiError(
          503,
          'REPORT_SCAN_LIMIT',
          'This account exceeds the complete report scan limit.',
        );
      const rows = listed.filter(
        (row) => row.ownerId === actor && row.purpose === 'studio-enquiry',
      );
      if (
        rows.length > ENQUIRY_REPORT_LIMIT ||
        new Set(rows.map((row) => row.id)).size !== rows.length
      )
        throw new ApiError(
          503,
          'REPORT_LIMIT',
          'The retained enquiry records exceed the complete report limit or contain duplicate identities.',
        );
      const entries = rows.map((row) => readStudioEnquiry(row, actor));
      for (let offset = 0; offset < rows.length; offset += 8)
        await Promise.all(
          rows.slice(offset, offset + 8).map(async (row) => {
            let fresh;
            try {
              fresh = await store().get(row.id);
            } catch (error) {
              if (error instanceof ApiError && error.status === 404)
                throw new ApiError(
                  409,
                  'REPORT_CHANGED',
                  'Enquiries changed during the report read. Refresh the report.',
                );
              throw error;
            }
            if (!isDeepStrictEqual(fresh, row))
              throw new ApiError(
                409,
                'REPORT_CHANGED',
                'Enquiries changed during the report read. Refresh the report.',
              );
            readStudioEnquiry(fresh, actor, row.id);
          }),
        );
      return buildEnquiryReport(
        actor,
        new Date().toISOString(),
        entries,
        input.data,
      );
    });
    res.json(result);
  });
  return router;
}
