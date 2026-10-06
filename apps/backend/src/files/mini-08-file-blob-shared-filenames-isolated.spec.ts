import { FilesService, UploadedFilePayload } from './files.service';

/**
 * MINI-GATE 08 — file-blob-shared-filenames-isolated:
 * FileBlob is pure content facts (no filename). Two companies uploading the
 * same bytes share ONE blob row but each gets its own FileAttachment with its
 * own originalFilename — and listing/downloading company A's attachments never
 * shows company B's.
 */
describe('mini-08 file-blob-shared-filenames-isolated', () => {
  const COMPANY_A = 'company-A';
  const COMPANY_B = 'company-B';

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

  const BLOB = {
    id: 'blob-1',
    sha256: 'deadbeef',
    mimeType: 'application/pdf',
    size: 15n,
    storageKey: 'blobs/2026/10/deadbeef',
    createdBy: null,
    createdAt: new Date(),
  };

  function makeMocks() {
    const attachments: Record<string, unknown>[] = [];
    const prisma = {
      fileBlob: {
        // The blob always "exists" — both companies uploaded identical bytes,
        // so the sha256 dedupe hits and no S3 call is ever made.
        findUnique: jest.fn(async () => BLOB),
        create: jest.fn(),
      },
      fileAttachment: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          const row = { id: `att-${attachments.length + 1}`, createdAt: new Date(), ...args.data };
          attachments.push(row);
          return row;
        }),
        findMany: jest.fn(async (args: { where: { companyId: string; entityType?: string; entityId?: string } }) =>
          attachments
            .filter(
              (a) =>
                a.companyId === args.where.companyId &&
                (!args.where.entityType || a.entityType === args.where.entityType),
            )
            .map((a) => ({ ...a, fileBlob: BLOB })),
        ),
      },
    };
    const audit = { record: jest.fn() };
    const service = new FilesService(prisma as never, audit as never, {
      S3_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_ACCESS_KEY: 'x',
      S3_SECRET_KEY: 'x',
      S3_BUCKET: 'test',
      S3_FORCE_PATH_STYLE: true,
    } as never);
    return { service, prisma, attachments, audit };
  }

  it('uploading identical bytes by two companies creates ONE blob and TWO attachments', async () => {
    const { service, prisma, attachments } = makeMocks();

    const a = await service.upload(
      FILE_A,
      { entityType: 'sales_document', entityId: 'doc-1' },
      COMPANY_A,
      { id: 'u1', username: 'a' },
      {},
    );
    const b = await service.upload(
      FILE_B,
      { entityType: 'sales_document', entityId: 'doc-2' },
      COMPANY_B,
      { id: 'u2', username: 'b' },
      {},
    );

    // one shared blob (dedupe hit — S3 create never called)
    expect(a.blob.id).toBe(BLOB.id);
    expect(b.blob.id).toBe(BLOB.id);
    expect(prisma.fileBlob.create).not.toHaveBeenCalled();
    expect(prisma.fileAttachment.create).toHaveBeenCalledTimes(2);

    // two attachments, different companies, different original filenames
    expect(attachments).toHaveLength(2);
    const [attA, attB] = attachments as {
      companyId: string;
      originalFilename: string;
      fileBlobId: string;
    }[];
    expect(attA.companyId).toBe(COMPANY_A);
    expect(attB.companyId).toBe(COMPANY_B);
    expect(attA.originalFilename).toBe(FILE_A.originalname);
    expect(attB.originalFilename).toBe(FILE_B.originalname);
    expect(attA.fileBlobId).toBe(attB.fileBlobId);
  });

  it('upload requires entityType and entityId', async () => {
    const { service } = makeMocks();
    await expect(
      service.upload(
        FILE_A,
        { entityType: '', entityId: '' },
        COMPANY_A,
        { id: 'u1', username: 'a' },
        {},
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it("listing company A's attachments never shows company B's", async () => {
    const { service, attachments } = makeMocks();
    await service.upload(FILE_A, { entityType: 'sales_document', entityId: 'doc-1' }, COMPANY_A, { id: 'u1', username: 'a' }, {});
    await service.upload(FILE_B, { entityType: 'sales_document', entityId: 'doc-2' }, COMPANY_B, { id: 'u2', username: 'b' }, {});

    const listA = await service.listAttachments(COMPANY_A, {});
    const listB = await service.listAttachments(COMPANY_B, {});

    expect(listA).toHaveLength(1);
    expect(listA[0].originalFilename).toBe(FILE_A.originalname);
    expect(listA.every((row) => row.companyId === COMPANY_A)).toBe(true);

    expect(listB).toHaveLength(1);
    expect(listB[0].originalFilename).toBe(FILE_B.originalname);
    expect(listB.every((row) => row.companyId === COMPANY_B)).toBe(true);
    expect(attachments).toHaveLength(2);
  });

  it('the blob carries no filename — filenames live only on attachments', async () => {
    const { service } = makeMocks();
    const result = await service.upload(
      FILE_A,
      { entityType: 'sales_document', entityId: 'doc-1', displayName: 'مستند فروش' },
      COMPANY_A,
      { id: 'u1', username: 'a' },
      {},
    );
    expect(result.blob).not.toHaveProperty('filename');
    expect(result.attachment.originalFilename).toBe(FILE_A.originalname);
    expect(result.attachment.displayName).toBe('مستند فروش');
  });
});
