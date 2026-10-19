import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import {
  MAX_EXTRACTED_CHARS_PER_FILE,
  MAX_UPLOAD_FILE_BYTES,
  MAX_UPLOAD_FILES,
  MAX_UPLOAD_TOTAL_BYTES,
} from '../rag';
import type { RagDocument } from '../rag';

function getExtension(name: string): string {
  return name.toLowerCase().split('.').pop() ?? '';
}

export async function extractUploadedDocuments(files: File[]): Promise<RagDocument[]> {
  if (files.length > MAX_UPLOAD_FILES) {
    throw new Error(`Upload no more than ${MAX_UPLOAD_FILES} PDF or DOCX files per run.`);
  }
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
    throw new Error('The combined upload size must not exceed 15 MB.');
  }

  const documents = await Promise.all(
    files.map(async (file): Promise<RagDocument> => {
      if (file.size === 0) throw new Error(`${file.name} is empty.`);
      if (file.size > MAX_UPLOAD_FILE_BYTES) {
        throw new Error(`${file.name} exceeds the 5 MB per-file upload limit.`);
      }
      const extension = getExtension(file.name);
      if (extension !== 'pdf' && extension !== 'docx') {
        throw new Error(`${file.name}: only PDF and DOCX Word files are supported.`);
      }

      const bytes = Buffer.from(await file.arrayBuffer());
      let text: string;
      if (extension === 'pdf') {
        if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
          throw new Error(`${file.name} does not appear to be a valid PDF.`);
        }
        const parsed = await pdfParse(bytes);
        text = parsed.text;
      } else {
        if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
          throw new Error(`${file.name} does not appear to be a valid DOCX document.`);
        }
        const extracted = await mammoth.extractRawText({ buffer: bytes });
        text = extracted.value;
      }

      const normalized = text.replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
      if (!normalized) {
        throw new Error(`${file.name} contains no extractable text. Scanned PDFs need OCR.`);
      }
      return {
        name: file.name,
        source: `upload:${file.name}`,
        text:
          normalized.length > MAX_EXTRACTED_CHARS_PER_FILE
            ? normalized.slice(0, MAX_EXTRACTED_CHARS_PER_FILE)
            : normalized,
      };
    }),
  );
  return documents;
}
