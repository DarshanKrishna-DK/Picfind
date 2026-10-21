import { randomUUID } from 'node:crypto';
import { enquiryFixture } from './studio-enquiries';
import {
  ENQUIRY_REPORT_ACTOR,
  blankEnquiryReportFilters,
  type EnquiryReportFilters,
} from '../../packages/shared/src/enquiry-report';
import type { Enquiry } from '../../packages/shared/src/studio-enquiries';
export async function enquiryReportFixture() {
  const f = enquiryFixture();
  await f.publish().expect(200);
  await f.submit().expect(201);
  const original = structuredClone(f.records.get(f.enquiryId)!);
  f.records.delete(f.enquiryId);
  function add(
    sessionType = 'Portraits',
    stage: Enquiry['stage'] = 'new',
    createdAt = '2026-10-21T12:00:00.000Z',
  ) {
    const id = randomUUID(),
      value = {
        ...original.studioEnquiry!,
        id,
        sessionType,
        stage,
        createdAt,
        updatedAt: createdAt,
        note: 'Secret follow-up instructions',
        history:
          stage === 'new'
            ? [{ stage, at: createdAt }]
            : [
                { stage: 'new' as const, at: createdAt },
                { stage, at: createdAt },
              ],
      };
    f.records.set(id, {
      ...structuredClone(original),
      id,
      createdAt,
      studioEnquiry: value,
    });
    return id;
  }
  const ids = [
    add('Portraits', 'new', '2026-10-20T23:59:59.999Z'),
    add('Portraits', 'qualified', '2026-10-21T00:00:00.000Z'),
    add('Wedding', 'contacted', '2026-10-21T23:59:59.999Z'),
    add('Corporate', 'closed', '2026-10-22T00:00:00.000Z'),
  ];
  const reportRoot = '/api/studio/enquiry-report';
  const report = (
    filters: Partial<EnquiryReportFilters> = {},
    actor = f.ownerId,
  ) =>
    f
      .read(
        `${reportRoot}?${new URLSearchParams({ ...blankEnquiryReportFilters(), ...filters })}`,
        actor,
      )
      .set(ENQUIRY_REPORT_ACTOR, actor);
  return { ...f, ids, add, reportRoot, report };
}
