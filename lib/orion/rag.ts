export interface RagDocument {
  name: string;
  source: string;
  text: string;
}

export interface RagChunk extends RagDocument {
  id: string;
  embedding: number[];
}

export interface RetrievedChunk {
  id: string;
  name: string;
  source: string;
  text: string;
  score: number;
}

export type EmbedTexts = (texts: string[]) => Promise<number[][]>;

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 180;
const MAX_CHUNKS = 400;
const EMBEDDING_BATCH_SIZE = 32;
export const MAX_UPLOAD_FILES = 5;
export const MAX_UPLOAD_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_UPLOAD_TOTAL_BYTES = 15 * 1024 * 1024;
export const MAX_EXTRACTED_CHARS_PER_FILE = 60_000;

export function splitIntoChunks(
  text: string,
  chunkSize = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP,
): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  if (chunkSize <= 0 || overlap < 0 || overlap >= chunkSize) {
    throw new Error('Chunk size must be positive and overlap must be smaller than chunk size.');
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + chunkSize, normalized.length);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf(' ', end);
      if (boundary > start + Math.floor(chunkSize * 0.65)) end = boundary;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) {
    throw new Error('Embedding vectors must have the same non-zero dimension.');
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index++) {
    const a = left[index];
    const b = right[index];
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      throw new Error('Embedding vector contains a non-finite value.');
    }
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export class InMemoryRagIndex {
  private chunks: RagChunk[] = [];

  static async create(documents: RagDocument[], embedTexts: EmbedTexts): Promise<InMemoryRagIndex> {
    const index = new InMemoryRagIndex();
    await index.addDocuments(documents, embedTexts);
    if (index.size === 0) throw new Error('No readable text was found in the supplied sources.');
    return index;
  }

  async addDocuments(documents: RagDocument[], embedTexts: EmbedTexts): Promise<void> {
    const pending = documents.flatMap((document, documentIndex) =>
      splitIntoChunks(document.text).map((text, chunkIndex) => ({
        id: `${this.chunks.length + documentIndex + 1}-${chunkIndex + 1}`,
        name: document.name,
        source: document.source,
        text,
      })),
    );
    if (pending.length === 0) return;
    if (this.chunks.length + pending.length > MAX_CHUNKS) {
      throw new Error(
        `Sources exceed the per-run limit of ${MAX_CHUNKS} total chunks.`,
      );
    }

    const chunks: RagChunk[] = [];
    for (let offset = 0; offset < pending.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = pending.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      const embeddings = await embedTexts(batch.map((chunk) => chunk.text));
      if (
        embeddings.length !== batch.length ||
        embeddings.some((embedding) => !Array.isArray(embedding) || embedding.length === 0)
      ) {
        throw new Error('Embedding service returned an invalid vector batch.');
      }
      chunks.push(...batch.map((chunk, index) => ({ ...chunk, embedding: embeddings[index] })));
    }
    this.chunks.push(...chunks);
  }

  get size(): number {
    return this.chunks.length;
  }

  async search(
    query: string,
    embedTexts: EmbedTexts,
    topK = 5,
  ): Promise<RetrievedChunk[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) throw new Error('A non-empty retrieval query is required.');
    const [queryEmbedding] = await embedTexts([normalizedQuery]);
    if (!queryEmbedding?.length) throw new Error('Embedding service returned no query vector.');

    return this.chunks
      .map((chunk) => ({
        id: chunk.id,
        name: chunk.name,
        source: chunk.source,
        text: chunk.text,
        score: cosineSimilarity(queryEmbedding, chunk.embedding),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(1, Math.min(Math.floor(topK), 8)));
  }
}

export function formatRetrievedContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return 'No relevant source passages were retrieved.';
  return chunks
    .map(
      (chunk, index) =>
        `[${index + 1}] Source: ${chunk.name} (${chunk.source}) | Relevance: ${chunk.score.toFixed(3)}\n${chunk.text}`,
    )
    .join('\n\n');
}
