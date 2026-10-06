import { createHash } from 'node:crypto';
import { FilesService, UploadedFilePayload } from './files.service';

/**
 * c3b-14 — file-metadata-company-isolation: metadata, listing and downloads
 * never cross companies. A blob is only visible/downloadable through a
 * company-valid attachment (same company AND, for company-scoped entity
 * types, an existing same-company target entity). Shared blobs keep the
 * global dedupe but each company only ever sees its own filenames.
 */
describe('c3b-14 file-metadata-company-isolation', () => {
  const COMPANY_A = '00000000-0000-4000-8000-000000000001';
  const COMPANY_B = '00000000-0000-4000-8000-000000000002';
  const PARTY_A = '33333333-3333-4333-8333-333333333333';
  const PARTY_B = '44444444-4444-4444-8444-444444444444';

  const FILE_A: UploadedFilePayload = {
    buffer: Buffer.from('identical-bytes'),
    originalname: 'فاکتور-شرکت-الف.pdf',
    mimetype: 'application/pdf',
    size: 15,
  };
  const FILE_B: UploadedFilePayload = {
    buffer: Buffer.from('identical-bytes'),
    originalname: 'invoice-company-b.pdf',
    mimetype: 'application/pdf',
    size: 15,
  };

  function makeService() {
    const attachments: Record<string, unknown>[] = [];
    let seq = 0;

    // The blob always "exists" (sha256 of the identical bytes) so the upload
    // dedupe hits and no S3 call is ever made — the subject here is metadata
    // isolation, not storage.
    const sharedBlob = {
      id: 'blob-shared',
      sha256: createHash('sha256').update(FILE_A.buffer).digest('hex'),
      mimeType: 'application/pdf',
      size: 15n,
      storageKey: 'blobs/2026/10/shared',
      createdBy: null,
      createdAt: new Date(),
    };
    const blobs: Record<string, unknown>[] = [sharedBlob];

    const prisma = {
      fileBlob: {
        findUnique: jest.fn(async (args: { where: { id?: string; sha256?: string }; include?: unknown }) => {
          const blob = blobs.find(
            (b) =>
              (args.where.id !== undefined && b.id === args.where.id) ||
              (args.where.sha256 !== undefined && b.sha256 === args.where.sha256),
          );
          if (!blob) return null;
          const include = args.include as
            | { attachments?: { where?: { companyId?: string } } }
            | undefined;
          const wantedCompany = include?.attachments?.where?.companyId;
          const companyAttachments = (attachments as Array<Record<string, unknown>>)
            .filter((a) => a.fileBlobId === blob.id)
            .filter((a) => (wantedCompany ? a.companyId === wantedCompany : true));
          return { ...blob, attachments: companyAttachments };
        }),
        create: jest.fn(),
      },
      fileAttachment: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          const row = { id: `att-${++seq}`, createdAt: new Date(), ...args.data };
          attachments.push(row);
          return row;
        }),
        findFirst: jest.fn(async (args: { where: { id: string; companyId: string } }) => {
          const row = (attachments as Array<Record<string, unknown>>).find(
            (a) => a.id === args.where.id && a.companyId === args.where.companyId,
          );
          if (!row) return null;
          return { ...row, fileBlob: blobs.find((b) => b.id === row.fileBlobId) };
        }),
        findMany: jest.fn(async (args: { where: { companyId: string } }) =>
          (attachments as Array<Record<string, unknown>>)
            .filter((a) => a.companyId === args.where.companyId)
            .map((a) => ({ ...a, fileBlob: blobs.find((b) => b.id === a.fileBlobId) })),
        ),
      },
      // Company-scoped entity lookup for the retrieval guard (entityType 'party').
      party: {
        findUnique: jest.fn(async (args: { where: { id: string } }) => {
          if (args.where.id === PARTY_A) return { companyId: COMPANY_A };
          if (args.where.id === PARTY_B) return { companyId: COMPANY_B };
          return null;
        }),
      },
    };
    const audit = { record: jest.fn(), recordTx: jest.fn() };
    const service = new FilesService(prisma as never, audit as never, {
      S3_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY: 'x',
      S3_SECRET_KEY: 'x',
      S3_BUCKET: 'test',
      S3_FORCE_PATH_STYLE: true,
    } as never);
    return { service, prisma, blobs, attachments };
  }

  it('getMeta of another company blob → 404 (metadata is invisible cross-company)', async () => {
    const { service } = makeService();
    const b = await service.upload(FILE_B, { entityType: 'party', entityId: PARTY_B }, COMPANY_B, { id: 'u2', username: 'b' }, {});
    await expect(service.getMeta(b.blob.id, COMPANY_A)).rejects.toMatchObject({
      statusCode: 404,
      message: 'File not found',
    });
  });

  it('shared blob (identical bytes): each company sees ONLY its own attachment/filename', async () => {
    const { service } = makeService();
    const same: UploadedFilePayload = { ...FILE_A, originalname: 'invoice-company-b.pdf' };
    const a = await service.upload(FILE_A, { entityType: 'party', entityId: PARTY_A }, COMPANY_A, { id: 'u1', username: 'a' }, {});
    const b = await service.upload(same, { entityType: 'party', entityId: PARTY_B }, COMPANY_B, { id: 'u2', username: 'b' }, {});
    expect(a.blob.id).toBe(b.blob.id); // dedupe shares the blob

    const metaA = (await service.getMeta(a.blob.id, COMPANY_A)) as {
      attachments: Array<{ originalFilename: string }>;
    };
    expect(metaA.attachments).toHaveLength(1);
    expect(metaA.attachments[0].originalFilename).toBe(FILE_A.originalname);
    // B's filename never leaks into A's metadata
    expect(metaA.attachments.some((x) => x.originalFilename === 'invoice-company-b.pdf')).toBe(false);

    const metaB = (await service.getMeta(a.blob.id, COMPANY_B)) as {
      attachments: Array<{ originalFilename: string }>;
    };
    expect(metaB.attachments).toHaveLength(1);
    expect(metaB.attachments[0].originalFilename).toBe('invoice-company-b.pdf');
  });

  it('download through a company-scoped attachment whose target entity is missing → 404', async () => {
    const { service, attachments } = makeService();
    const a = await service.upload(FILE_A, { entityType: 'party', entityId: PARTY_A }, COMPANY_A, { id: 'u1', username: 'a' }, {});
    // break the target entity: point the attachment at a nonexistent party
    attachments[0].entityId = '99999999-9999-4999-8999-999999999999';
    await expect(
      service.downloadAttachment(a.attachment.id, COMPANY_A),
    ).rejects.toMatchObject({ statusCode: 404, message: 'Attached entity not found' });
    await expect(service.download(a.blob.id, COMPANY_A)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Attached entity not found',
    });
  });

  it("listing company A's attachments never shows company B's filenames", async () => {
    const { service } = makeService();
    await service.upload(FILE_A, { entityType: 'party', entityId: PARTY_A }, COMPANY_A, { id: 'u1', username: 'a' }, {});
    await service.upload(FILE_B, { entityType: 'party', entityId: PARTY_B }, COMPANY_B, { id: 'u2', username: 'b' }, {});

    const listA = await service.listAttachments(COMPANY_A, {});
    expect(listA.every((row) => row.companyId === COMPANY_A)).toBe(true);
    expect(listA.some((row) => row.originalFilename === FILE_B.originalname)).toBe(false);
    expect(listA.some((row) => row.originalFilename === FILE_A.originalname)).toBe(true);
  });

  it('an attachment whose target sits in ANOTHER company is not listable/downloadable', async () => {
    const { service } = makeService();
    // Bad data: company B attached a file to company A's party (upload does
    // not resolve entities; retrieval must not serve it).
    const b = await service.upload(
      FILE_B,
      { entityType: 'party', entityId: PARTY_A },
      COMPANY_B,
      { id: 'u2', username: 'b' },
      {},
    );
    await expect(
      service.downloadAttachment(b.attachment.id, COMPANY_B),
    ).rejects.toMatchObject({ statusCode: 403, message: 'Attachment belongs to another company' });
    const listB = await service.listAttachments(COMPANY_B, {});
    expect(listB).toHaveLength(0);
  });
});
