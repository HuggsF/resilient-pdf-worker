import type { Knex } from 'knex';
import { Certificate } from '@domain/entities/certificate.entity';
import { MySqlCertificateRepository } from '@infrastructure/database/mysql-certificate.repository';

describe('MySqlCertificateRepository', () => {
  let mockDb: jest.Mock & {
    insert: jest.Mock;
    onConflict: jest.Mock;
    merge: jest.Mock;
    where: jest.Mock;
    first: jest.Mock;
    orderBy: jest.Mock;
    limit: jest.Mock;
    update: jest.Mock;
    select: jest.Mock;
    count: jest.Mock;
    groupBy: jest.Mock;
  };

  beforeEach(() => {
    const chain: Record<string, jest.Mock> = {
      insert: jest.fn().mockReturnThis(),
      onConflict: jest.fn().mockReturnThis(),
      merge: jest.fn().mockResolvedValue(undefined),
      where: jest.fn().mockReturnThis(),
      first: jest.fn(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn(),
      update: jest.fn().mockResolvedValue(1),
      select: jest.fn().mockReturnThis(),
      count: jest.fn().mockReturnThis(),
      groupBy: jest.fn(),
    };

    mockDb = jest.fn(() => chain) as unknown as typeof mockDb;
    Object.assign(mockDb, chain);
  });

  const createSampleCert = (): Certificate => {
    const res = Certificate.create({
      id: 'cert-repo-1',
      studentId: 'student-100',
      studentName: 'Charles Babbage',
      courseName: 'Analytical Engines 101',
      completionDate: '2026-04-12',
      createdAt: new Date('2026-04-12T10:00:00.000Z'),
    });
    if (!res.success) throw res.error;
    return res.data;
  };

  it('saves a certificate using ON DUPLICATE KEY UPDATE (insert + onConflict)', async () => {
    const repo = new MySqlCertificateRepository(mockDb as unknown as Knex);
    const cert = createSampleCert();

    await repo.save(cert);

    expect(mockDb).toHaveBeenCalledWith('certificates');
    expect(mockDb.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'cert-repo-1',
        student_id: 'student-100',
        student_name: 'Charles Babbage',
        course_name: 'Analytical Engines 101',
        status: 'pending',
      }),
    );
    expect(mockDb.onConflict).toHaveBeenCalledWith('id');
    expect(mockDb.merge).toHaveBeenCalledWith([
      'status',
      'pdf_url',
      'attempts',
      'last_error',
      'updated_at',
    ]);
  });

  it('findById returns the restored Certificate entity when found', async () => {
    const repo = new MySqlCertificateRepository(mockDb as unknown as Knex);
    mockDb.first.mockResolvedValueOnce({
      id: 'cert-found-1',
      student_id: 'std-1',
      student_name: 'Grace Hopper',
      course_name: 'Compiler Design',
      completion_date: '2026-01-01',
      status: 'completed',
      pdf_url: 'https://example.com/cert.pdf',
      attempts: 1,
      last_error: null,
      created_at: '2026-01-01 10:00:00',
      updated_at: '2026-01-01 10:05:00',
    });

    const cert = await repo.findById('cert-found-1');

    expect(cert).not.toBeNull();
    expect(cert?.id).toBe('cert-found-1');
    expect(cert?.status).toBe('completed');
    expect(cert?.pdfUrl).toBe('https://example.com/cert.pdf');
  });

  it('findById returns null when row does not exist', async () => {
    const repo = new MySqlCertificateRepository(mockDb as unknown as Knex);
    mockDb.first.mockResolvedValueOnce(undefined);

    const cert = await repo.findById('non-existent');

    expect(cert).toBeNull();
  });

  it('findByStatus queries certificates with given status and limit', async () => {
    const repo = new MySqlCertificateRepository(mockDb as unknown as Knex);
    mockDb.limit.mockResolvedValueOnce([
      {
        id: 'cert-p1',
        student_id: 'std-1',
        student_name: 'John von Neumann',
        course_name: 'Computer Architecture',
        completion_date: '2026-02-02',
        status: 'pending',
        pdf_url: null,
        attempts: 0,
        last_error: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);

    const results = await repo.findByStatus('pending', 50);

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('pending');
    expect(mockDb.where).toHaveBeenCalledWith({ status: 'pending' });
    expect(mockDb.limit).toHaveBeenCalledWith(50);
  });

  it('updateStatus updates status, optional pdfUrl and error', async () => {
    const repo = new MySqlCertificateRepository(mockDb as unknown as Knex);

    await repo.updateStatus('cert-update-1', 'completed', 'http://pdf.url');

    expect(mockDb.where).toHaveBeenCalledWith({ id: 'cert-update-1' });
    expect(mockDb.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        pdf_url: 'http://pdf.url',
      }),
    );
  });

  it('countByStatus returns aggregated counts for each status', async () => {
    const repo = new MySqlCertificateRepository(mockDb as unknown as Knex);
    mockDb.groupBy.mockResolvedValueOnce([
      { status: 'pending', total: '3' },
      { status: 'completed', total: 7 },
      { status: 'failed', total: '1' },
    ]);

    const counts = await repo.countByStatus();

    expect(counts).toEqual({
      pending: 3,
      processing: 0,
      completed: 7,
      failed: 1,
      dead_letter: 0,
    });
  });
});
