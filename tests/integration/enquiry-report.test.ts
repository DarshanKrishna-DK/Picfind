import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import { enquiryReportFixture } from '../fixtures/enquiry-report';
import { ApiError } from '../../apps/api/src/auth';
import {
  ENQUIRY_REPORT_ACTOR,
  enquiryReport,
  enquiryReportCounts,
  enquiryReportCsv,
} from '../../packages/shared/src/enquiry-report';
describe('complete private enquiry reports', () => {
  it('reports real retained counts and omits contacts, messages and notes by default', async () => {
    const f = await enquiryReportFixture(),
      put = vi.spyOn(f.store, 'put');
    const response = await f.read(f.reportRoot).expect(200),
      value = enquiryReport.parse(response.body);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(value.retainedCount).toBe(4);
    expect(value.rows).toHaveLength(4);
    expect(enquiryReportCounts(value)).toEqual({
      stages: [
        { stage: 'new', count: 1 },
        { stage: 'contacted', count: 1 },
        { stage: 'qualified', count: 1 },
        { stage: 'closed', count: 1 },
      ],
      sessions: [
        { sessionType: 'Portraits', count: 2 },
        { sessionType: 'Corporate', count: 1 },
        { sessionType: 'Wedding', count: 1 },
      ],
    });
    for (const secret of [
      f.contact.name,
      f.contact.email,
      f.contact.phone,
      f.contact.message,
      'Secret follow-up instructions',
      'consent',
      'history',
      'enquirySubmissionDigest',
    ])
      expect(JSON.stringify(value)).not.toContain(secret);
    expect(put).not.toHaveBeenCalled();
  });
  it('includes self-reported contacts only when explicitly requested', async () => {
    const f = await enquiryReportFixture(),
      r = await f.report({ contacts: 'include' }).expect(200);
    expect(r.body.rows[0].contact).toEqual({
      name: f.contact.name,
      email: f.contact.email,
      phone: f.contact.phone,
    });
    expect(JSON.stringify(r.body)).not.toContain(f.contact.message);
    expect(
      enquiryReport.safeParse({
        ...r.body,
        filters: { ...r.body.filters, contacts: 'omit' },
      }).success,
    ).toBe(false);
    delete r.body.rows[0].contact;
    expect(enquiryReport.safeParse(r.body).success).toBe(false);
  });
  it('filters inclusive received UTC dates independently of the requested session date', async () => {
    const f = await enquiryReportFixture(),
      r = await f.report({ from: '2026-10-21', to: '2026-10-21' }).expect(200);
    expect(r.body.rows.map((row: { id: string }) => row.id)).toEqual([
      f.ids[2],
      f.ids[1],
    ]);
    expect(r.body.retainedCount).toBe(4);
    expect(
      (await f.report({ from: '2026-12-01' }).expect(200)).body.rows,
    ).toEqual([]);
  });
  it('combines trimmed case-insensitive session text and exact stage filters', async () => {
    const f = await enquiryReportFixture(),
      r = await f
        .report({ session: '  PORTRAIT ', stage: 'qualified' })
        .expect(200);
    expect(r.body.rows.map((row: { id: string }) => row.id)).toEqual([
      f.ids[1],
    ]);
    expect(
      enquiryReportCounts(r.body).stages.find(
        (row) => row.stage === 'qualified',
      )!.count,
    ).toBe(1);
  });
  it('rejects malformed, reversed, repeated and unknown filter values', async () => {
    const f = await enquiryReportFixture();
    for (const suffix of [
      '?from=2026-02-30',
      '?from=2026-10-22&to=2026-10-21',
      '?stage=booked',
      '?contacts=true',
      '?stage=new&stage=closed',
      '?offset=50',
    ])
      await f.read(f.reportRoot + suffix).expect(400);
  });
  it('enforces session and account identity, excludes foreign sources and never exposes their counts', async () => {
    const f = await enquiryReportFixture();
    await request(f.app).get(f.reportRoot).expect(401);
    await f
      .read(f.reportRoot)
      .set(ENQUIRY_REPORT_ACTOR, f.strangerId)
      .expect(403);
    expect(
      (await f.report({}, f.strangerId).expect(200)).body.retainedCount,
    ).toBe(0);
    const list = f.store.list.bind(f.store),
      row = f.records.get(f.ids[0]!)!;
    vi.spyOn(f.store, 'list').mockImplementation(async (...args) => [
      ...(await list(...args)),
      { ...row, id: randomUUID(), ownerId: f.strangerId },
    ]);
    expect((await f.report().expect(200)).body.retainedCount).toBe(4);
  });
  it('fails closed on damaged records and inconsistent response counts', async () => {
    const f = await enquiryReportFixture(),
      r = await f.report().expect(200);
    expect(
      enquiryReport.safeParse({ ...r.body, retainedCount: 1 }).success,
    ).toBe(false);
    expect(
      enquiryReport.safeParse({
        ...r.body,
        rows: [r.body.rows[0], r.body.rows[0]],
      }).success,
    ).toBe(false);
    expect(
      enquiryReport.safeParse({
        ...r.body,
        filters: { ...r.body.filters, stage: 'qualified' },
      }).success,
    ).toBe(false);
    f.records.get(f.ids[0]!)!.studioEnquiry!.history = [];
    await f.report().expect(503);
  });
  it('rejects deleted, transferred or changed sources after listing', async () => {
    for (const mode of ['delete', 'transfer', 'edit']) {
      const f = await enquiryReportFixture(),
        list = f.store.list.bind(f.store);
      vi.spyOn(f.store, 'list').mockImplementation(async (...args) => {
        const rows = await list(...args),
          id = f.ids[0]!;
        if (mode === 'delete') f.records.delete(id);
        if (mode === 'transfer') f.records.get(id)!.ownerId = f.strangerId;
        if (mode === 'edit')
          f.records.get(id)!.studioEnquiry!.sessionType = 'Changed session';
        return rows;
      });
      await f.report().expect(409);
    }
  });
  it('does not turn store failures into empty reports', async () => {
    const f = await enquiryReportFixture();
    vi.spyOn(f.store, 'list').mockRejectedValueOnce(
      new ApiError(503, 'SOURCE_FAILURE', 'Unavailable source'),
    );
    await f.report().expect(503);
    vi.spyOn(f.store, 'get').mockRejectedValueOnce(
      new ApiError(503, 'SOURCE_FAILURE', 'Unavailable source'),
    );
    await f.report().expect(503);
  });
  it('returns all recovery-limit records with bounded read concurrency and rejects overflow', async () => {
    const f = await enquiryReportFixture();
    for (let n = 4; n < 500; n++) f.add(`Session ${n}`);
    const get = f.store.get.bind(f.store);
    let active = 0,
      maximum = 0;
    const spy = vi.spyOn(f.store, 'get').mockImplementation(async (id) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      try {
        return await get(id);
      } finally {
        active--;
      }
    });
    const r = await f.report().expect(200);
    expect(r.body.rows).toHaveLength(500);
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(8);
    expect(enquiryReportCsv(r.body).split('\r\n')).toHaveLength(502);
    f.add();
    spy.mockClear();
    await f.report().expect(503);
    expect(spy).not.toHaveBeenCalled();
  });
  it('rejects duplicate listed identities and oversized scans', async () => {
    const f = await enquiryReportFixture(),
      list = f.store.list.bind(f.store);
    vi.spyOn(f.store, 'list').mockImplementationOnce(async (...args) => [
      ...(await list(...args)),
      f.records.get(f.ids[0]!)!,
    ]);
    await f.report().expect(503);
    vi.mocked(f.store.list).mockResolvedValueOnce(
      Array.from({ length: 2001 }, () => f.records.get(f.ids[0]!)!),
    );
    await f.report().expect(503);
  });
  it('escapes CSV cells and neutralizes formula-shaped session and contact text', async () => {
    const f = await enquiryReportFixture(),
      row = f.records.get(f.ids[0]!)!.studioEnquiry!;
    row.sessionType = '=HYPERLINK("https://example.test","session")';
    row.name = '@SUM(1,2)';
    row.phone = '+91 9000000000';
    const r = await f.report({ contacts: 'include' }).expect(200),
      csv = enquiryReportCsv(r.body);
    expect(csv).toContain(
      `"'=HYPERLINK(""https://example.test"",""session"")"`,
    );
    expect(csv).toContain(`"'@SUM(1,2)"`);
    expect(csv).toContain(`"'+91 9000000000"`);
    expect(csv).toContain('Name (unverified)');
    expect(csv).not.toContain('Secret follow-up instructions');
    const omitted = enquiryReportCsv((await f.report().expect(200)).body);
    expect(omitted).not.toContain('Name (unverified)');
    expect(omitted).not.toContain(f.contact.email);
  });
  it('exports a valid header-only CSV for no matching enquiries', async () => {
    const f = await enquiryReportFixture(),
      r = await f.report({ session: 'nonexistent' }).expect(200);
    expect(enquiryReportCsv(r.body).split('\r\n')).toHaveLength(2);
    expect(
      enquiryReportCounts(r.body).stages.every((row) => row.count === 0),
    ).toBe(true);
  });
  it('revokes report access after account erasure', async () => {
    const f = await enquiryReportFixture();
    await f
      .remove('/api/account', {
        password: 'test-password',
        emailCode: '123456',
        confirmation: 'DELETE',
      })
      .expect(204);
    await f.report().expect(401);
  });
});
