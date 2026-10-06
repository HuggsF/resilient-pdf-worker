import { UnexpectedError } from '@application/errors/unexpected.error';
import { ReprocessDlqUseCase } from '@application/use-cases/reprocess-dlq.use-case';
import type { Certificate } from '@domain/entities/certificate.entity';
import {
  FakeMessageBroker,
  FixedClock,
  InMemoryCertificateRepository,
  Timeline,
  aCertificate,
  createLoggerMock,
  inState,
  jobMessage,
  rawMessage,
} from '../../../support/fakes';

const DLQ = 'certificate.dlq';

const deadLettered = (id: string): Certificate =>
  inState(aCertificate({ id }), 'processing', 'failed', 'dead_letter');

type Setup = {
  readonly repository: InMemoryCertificateRepository;
  readonly broker: FakeMessageBroker;
  readonly timeline: Timeline;
  readonly useCase: ReprocessDlqUseCase;
};

const setup = (...seed: Certificate[]): Setup => {
  const timeline = new Timeline();
  const repository = new InMemoryCertificateRepository(timeline);
  const broker = new FakeMessageBroker(timeline);
  repository.seed(...seed);
  const useCase = new ReprocessDlqUseCase(
    repository,
    broker,
    new FixedClock(),
    createLoggerMock(),
    { defaultLimit: 100, maxLimit: 500 },
  );
  return { repository, broker, timeline, useCase };
};

describe('ReprocessDlqUseCase', () => {
  it('resets each certificate, republishes it to the main queue, and only then acks the DLQ copy', async () => {
    const { useCase, broker, repository, timeline } = setup(deadLettered('a'), deadLettered('b'));
    broker.enqueue(DLQ, jobMessage('a'), jobMessage('b'));

    const result = await useCase.execute({});

    expect(result).toEqual({
      success: true,
      data: { moved: 2, discarded: 0, kept: 0, remaining: 0 },
    });
    expect(timeline.entries).toEqual([
      'save:pending:0',
      'publish:certificate.generate',
      'ack',
      'save:pending:0',
      'publish:certificate.generate',
      'ack',
    ]);
    expect(broker.published.map(({ options }) => options?.messageId)).toEqual(['a', 'b']);
    expect(repository.certificates.get('a')).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('drops DLQ copies of certificates that were completed in the meantime', async () => {
    const completed = inState(aCertificate({ id: 'done' }), 'processing', 'completed');
    const { useCase, broker } = setup(completed);
    broker.enqueue(DLQ, jobMessage('done'));

    const result = await useCase.execute({});

    expect(result.success && result.data).toEqual({
      moved: 0,
      discarded: 1,
      kept: 0,
      remaining: 0,
    });
    expect(broker.published).toHaveLength(0);
    expect(broker.acked).toHaveLength(1);
  });

  it('keeps poison messages and unknown certificates in the DLQ without looping on them', async () => {
    const { useCase, broker } = setup(deadLettered('ok'));
    broker.enqueue(DLQ, rawMessage('garbage'), jobMessage('unknown'), jobMessage('ok'));

    const result = await useCase.execute({});

    expect(result.success && result.data).toEqual({
      moved: 1,
      discarded: 0,
      kept: 2,
      remaining: 2,
    });
    expect(broker.nacked.map(({ requeue }) => requeue)).toEqual([true, true]);
    expect(broker.unackedCount).toBe(0);
  });

  it('handles at most `limit` messages per call', async () => {
    const { useCase, broker } = setup(deadLettered('a'), deadLettered('b'), deadLettered('c'));
    broker.enqueue(DLQ, jobMessage('a'), jobMessage('b'), jobMessage('c'));

    const result = await useCase.execute({ limit: 2 });

    expect(result.success && result.data).toEqual({
      moved: 2,
      discarded: 0,
      kept: 0,
      remaining: 1,
    });
  });

  it('clamps the limit between 1 and maxLimit', async () => {
    const { useCase, broker } = setup(deadLettered('a'), deadLettered('b'));
    broker.enqueue(DLQ, jobMessage('a'), jobMessage('b'));

    const result = await useCase.execute({ limit: 0 });

    expect(result.success && result.data.moved).toBe(1);
  });

  it('gives the current message back to the DLQ when the database fails mid-way', async () => {
    const { useCase, broker, repository } = setup(deadLettered('a'));
    broker.enqueue(DLQ, jobMessage('a'));
    repository.failOn('save');

    const result = await useCase.execute({});

    expect(!result.success && result.error).toBeInstanceOf(UnexpectedError);
    expect(broker.nacked.map(({ requeue }) => requeue)).toEqual([true]);
    expect(await broker.messageCount(DLQ)).toBe(1);
    expect(broker.published).toHaveLength(0);
  });

  it('fails when the DLQ cannot be read', async () => {
    const { useCase, broker } = setup();
    broker.getError = new Error('channel closed');

    const result = await useCase.execute({});

    expect(!result.success && result.error).toBeInstanceOf(UnexpectedError);
    expect(broker.nacked).toHaveLength(0);
  });

  it('reports an unknown remaining depth when it cannot be read', async () => {
    const { useCase, broker } = setup();
    broker.countError = new Error('channel closed');

    const result = await useCase.execute({});

    expect(result.success && result.data.remaining).toBeNull();
  });
});
