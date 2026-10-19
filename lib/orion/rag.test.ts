import { describe, expect, it } from 'vitest';
import { formatRetrievedContext, InMemoryRagIndex, splitIntoChunks } from './rag';

function fakeEmbeddings(texts: string[]): Promise<number[][]> {
  return Promise.resolve(
    texts.map((text) => {
      const normalized = text.toLowerCase();
      return [
        normalized.includes('database') || normalized.includes('postgres') ? 1 : 0,
        normalized.includes('food') || normalized.includes('delivery') ? 1 : 0,
        normalized.includes('authentication') || normalized.includes('login') ? 1 : 0,
      ];
    }),
  );
}

describe('run-scoped RAG index', () => {
  it('splits text into overlapping chunks without losing the source text', () => {
    const text = Array.from({ length: 30 }, (_, index) => `word${index}`).join(' ');
    const chunks = splitIntoChunks(text, 40, 10);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toContain('word29');
    expect(chunks[0]?.slice(-10)).toBe(chunks[1]?.slice(0, 10));
  });

  it('retrieves semantically matching source passages with citation metadata', async () => {
    const index = await InMemoryRagIndex.create(
      [
        {
          name: 'product-notes.docx',
          source: 'upload:product-notes.docx',
          text: 'The food delivery app needs user login and restaurant checkout.',
        },
        {
          name: 'database-guide.pdf',
          source: 'upload:database-guide.pdf',
          text: 'Use PostgreSQL for reliable transactional data and relational records.',
        },
      ],
      fakeEmbeddings,
    );

    const results = await index.search('How should relational database persistence work?', fakeEmbeddings);

    expect(index.size).toBe(2);
    expect(results[0]?.source).toBe('upload:database-guide.pdf');
    expect(formatRetrievedContext(results)).toContain('database-guide.pdf');
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  it('appends newly indexed documents without replacing the existing index', async () => {
    const index = await InMemoryRagIndex.create(
      [{ name: 'first.pdf', source: 'upload:first.pdf', text: 'Postgres database notes' }],
      fakeEmbeddings,
    );

    await index.addDocuments(
      [{ name: 'second.docx', source: 'upload:second.docx', text: 'Food delivery notes' }],
      fakeEmbeddings,
    );

    expect(index.size).toBe(2);
    expect((await index.search('database', fakeEmbeddings))[0]?.source).toBe('upload:first.pdf');
    expect((await index.search('food', fakeEmbeddings))[0]?.source).toBe('upload:second.docx');
  });

  it('rejects empty source indexes and invalid query embedding dimensions', async () => {
    await expect(InMemoryRagIndex.create([], fakeEmbeddings)).rejects.toThrow(
      'No readable text was found',
    );
    const index = await InMemoryRagIndex.create(
      [{ name: 'notes.txt', source: 'upload:notes.txt', text: 'database notes' }],
      fakeEmbeddings,
    );
    await expect(index.search('database', async () => [[1]])).rejects.toThrow(
      'same non-zero dimension',
    );
  });
});
