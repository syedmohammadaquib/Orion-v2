/**
 * Lightweight URL fetch for ResearchAgent.
 * Production constraints: timeout, size cap, text-only extraction.
 */

const FETCH_TIMEOUT_MS = 12_000;
const MAX_BYTES = 400_000; // ~400KB
const MAX_TEXT_CHARS = 12_000;

export interface WebFetchResult {
  url: string;
  ok: boolean;
  title?: string;
  text?: string;
  error?: string;
  truncated?: boolean;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

export function extractUrls(text: string, limit = 3): string[] {
  const matches = text.match(URL_RE) || [];
  const cleaned = matches.map((u) => u.replace(/[.,;:!?)]+$/, ''));
  return Array.from(new Set(cleaned)).slice(0, limit);
}

function stripHtml(html: string): { title?: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim();

  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

  return { title, text };
}

export async function fetchUrlText(url: string): Promise<WebFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'OrionResearchBot/1.0 (+https://github.com/syedmohammadaquib/Orion-V2)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
    });

    if (!res.ok) {
      return { url, ok: false, error: `HTTP ${res.status}` };
    }

    const contentType = res.headers.get('content-type') || '';
    if (
      contentType &&
      !contentType.includes('text/') &&
      !contentType.includes('json') &&
      !contentType.includes('xml') &&
      !contentType.includes('html')
    ) {
      return { url, ok: false, error: `Unsupported content-type: ${contentType}` };
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return { url, ok: false, error: `Response too large (${buf.byteLength} bytes)` };
    }

    const raw = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    const { title, text } = contentType.includes('html') || raw.includes('<html')
      ? stripHtml(raw)
      : { text: raw.trim() };

    if (!text) {
      return { url, ok: false, error: 'Empty body after extraction' };
    }

    const truncated = text.length > MAX_TEXT_CHARS;
    return {
      url,
      ok: true,
      title,
      text: truncated ? text.slice(0, MAX_TEXT_CHARS) : text,
      truncated,
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? 'Fetch timed out'
          : err.message
        : 'Fetch failed';
    return { url, ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchUrlsFromText(source: string): Promise<{
  urls: string[];
  results: WebFetchResult[];
  sourcesBlock: string;
}> {
  const urls = extractUrls(source);
  if (urls.length === 0) {
    return {
      urls: [],
      results: [],
      sourcesBlock: 'No live URLs found in the objective. Analysis is model-only (no live sources).',
    };
  }

  const results = await Promise.all(urls.map((u) => fetchUrlText(u)));
  const ok = results.filter((r) => r.ok);

  if (ok.length === 0) {
    return {
      urls,
      results,
      sourcesBlock: `Attempted live fetch for: ${urls.join(', ')}\nAll fetches failed. Analysis is model-only.\nErrors: ${results
        .map((r) => `${r.url}: ${r.error}`)
        .join('; ')}`,
    };
  }

  const sourcesBlock = ok
    .map(
      (r, i) =>
        `### Source ${i + 1}: ${r.title || r.url}\nURL: ${r.url}${r.truncated ? ' (truncated)' : ''}\n${r.text}`,
    )
    .join('\n\n');

  return { urls, results, sourcesBlock };
}
