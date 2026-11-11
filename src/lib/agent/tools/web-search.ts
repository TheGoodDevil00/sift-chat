import Exa from 'exa-js';
import { isValidHttpUrl, getCanonicalUrl } from '../../citations/normalize';
import { isSafeRemoteUrl } from '../../security/endpoint';

/** A result URL is usable only if it is a public HTTP(S) URL we may later fetch. */
function isUsableResultUrl(url: unknown): url is string {
  return typeof url === 'string' && isValidHttpUrl(url) && isSafeRemoteUrl(url);
}

/** Decode the HTML entities search snippets carry into the prompt and UI. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export interface SearchEvidence {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
  retrievedAt: string;
  extractedContent?: string;
}

export interface WebSearchToolInput {
  query: string;
  recency?: 'day' | 'week' | 'month' | 'any';
  maxResults?: number;
  searchKeys?: {
    exa?: string;
    firecrawl?: string;
    tavily?: string;
  };
}

export interface WebSearchTool {
  name: 'web_search';
  execute(input: WebSearchToolInput): Promise<SearchEvidence[]>;
}

export const webSearchToolSchema = {
  name: 'web_search',
  description:
    'Search the live web for current evidence, official pricing, product release notes, changelogs, announcements, or freshness verification.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'The focused search query (e.g. "HubSpot Sales Hub pricing 2026", "Neon Postgres pricing changelog")',
      },
      recency: {
        type: 'string',
        enum: ['day', 'week', 'month', 'any'],
        description: 'Filter search by recency to isolate changes since a previous date',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of evidence results to return (default: 5)',
      },
    },
    required: ['query'],
  },
};

// ---------------------------------------------------------------------------
// 1. Exa: Neural Semantic Search + Content + Highlights ($10/mo Free Tier)
// ---------------------------------------------------------------------------
async function searchWithExa(
  query: string,
  maxResults: number,
  recency?: string,
  customKey?: string
): Promise<SearchEvidence[]> {
  const apiKey = customKey || process.env.EXA_API_KEY;
  if (!apiKey) throw new Error('EXA_API_KEY not configured');

  const exa = new (Exa as any)(apiKey);
  const retrievedAt = new Date().toISOString();

  let startPublishedDate: string | undefined;
  if (recency === 'day') {
    startPublishedDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  } else if (recency === 'week') {
    startPublishedDate = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  } else if (recency === 'month') {
    startPublishedDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  }

  const result = await exa.searchAndContents(query, {
    type: 'auto',
    numResults: maxResults,
    startPublishedDate,
    text: { maxCharacters: 3500 },
    highlights: {
      numSentences: 3,
      highlightsPerUrl: 2,
    },
    livecrawl: 'fallback',
  });

  return (result.results || [])
    .filter((r: any) => isUsableResultUrl(r.url))
    .map((r: any) => ({
      title: r.title || '',
      url: r.url,
      snippet: r.highlights?.join(' ') || r.text?.slice(0, 300) || '',
      publishedAt: r.publishedDate || null,
      retrievedAt,
      extractedContent: r.text || undefined,
    }))
    .filter(
      (item: SearchEvidence, i: number, arr: SearchEvidence[]) =>
        arr.findIndex((x) => getCanonicalUrl(x.url) === getCanonicalUrl(item.url)) === i
    );
}

// ---------------------------------------------------------------------------
// 2. Firecrawl: Search + Headless Chromium Markdown Scrape (1,000 Credits Free)
// ---------------------------------------------------------------------------
async function searchWithFirecrawl(
  query: string,
  maxResults: number,
  customKey?: string
): Promise<SearchEvidence[]> {
  const apiKey = customKey || process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY not configured');

  const res = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      limit: maxResults,
      scrapeOptions: {
        formats: ['markdown'],
      },
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`Firecrawl search failed (${res.status}): ${text}`);
    return [];
  }

  const json = await res.json();
  const items: any[] = json.data || [];
  const retrievedAt = new Date().toISOString();

  return items
    .filter((r: any) => isUsableResultUrl(r.url))
    .map((r: any) => ({
      title: r.metadata?.title || r.title || '',
      url: r.url,
      snippet: r.metadata?.description || r.description || '',
      publishedAt: r.metadata?.publishedDate || null,
      retrievedAt,
      extractedContent: r.markdown || r.content || undefined,
    }))
    .filter(
      (item: SearchEvidence, i: number, arr: SearchEvidence[]) =>
        arr.findIndex((x) => getCanonicalUrl(x.url) === getCanonicalUrl(item.url)) === i
    );
}

// ---------------------------------------------------------------------------
// 3. Fallback: Tavily Search
// ---------------------------------------------------------------------------
async function searchWithTavily(
  query: string,
  maxResults: number,
  recency?: string,
  customKey?: string
): Promise<SearchEvidence[]> {
  const apiKey = customKey || process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('TAVILY_API_KEY not configured');

  const body: Record<string, unknown> = {
    query,
    max_results: maxResults,
    include_raw_content: false,
    search_depth: 'advanced',
  };

  if (recency === 'day') body.days = 1;
  else if (recency === 'week') body.days = 7;
  else if (recency === 'month') body.days = 30;

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) return [];

  const json = await res.json();
  const retrievedAt = new Date().toISOString();

  return (json.results || [])
    .filter((r: any) => isUsableResultUrl(r.url))
    .map((r: any) => ({
      title: r.title || '',
      url: r.url,
      snippet: r.content || '',
      publishedAt: r.published_date || null,
      retrievedAt,
      extractedContent: r.content || undefined,
    }))
    .filter(
      (item: SearchEvidence, i: number, arr: SearchEvidence[]) =>
        arr.findIndex((x) => getCanonicalUrl(x.url) === getCanonicalUrl(item.url)) === i
    );
}

// ---------------------------------------------------------------------------
// 4. Free Keyless Fallback (DuckDuckGo HTML query)
// ---------------------------------------------------------------------------
async function searchWithKeylessFallback(
  cleanQuery: string,
  maxResults: number,
  recency?: string
): Promise<SearchEvidence[]> {
  const retrievedAt = new Date().toISOString();
  let recencyParam = '';
  if (recency === 'day') recencyParam = '&df=d';
  else if (recency === 'week') recencyParam = '&df=w';
  else if (recency === 'month') recencyParam = '&df=m';

  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}${recencyParam}`;
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return [];

    const html = await response.text();
    const results: SearchEvidence[] = [];

    const itemRegex =
      /<h2[^>]*class="[^"]*result__title[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)/gi;

    let match: RegExpExecArray | null;

    while ((match = itemRegex.exec(html)) !== null && results.length < maxResults) {
      let rawUrl = match[1];
      const title = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, '')).trim();
      const snippet = decodeHtmlEntities(
        (match[3] || match[4] || '').replace(/<[^>]+>/g, '')
      ).trim();

      if (rawUrl.includes('uddg=')) {
        try {
          const matchUddg = rawUrl.match(/uddg=([^&]+)/);
          if (matchUddg) {
            rawUrl = decodeURIComponent(matchUddg[1]);
          }
        } catch {}
      }

      if (rawUrl.startsWith('//')) {
        rawUrl = `https:${rawUrl}`;
      }

      let publishedAt: string | null = null;
      const dateMatch = snippet.match(
        /^([A-Za-z]{3}\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3}\s+\d{4}|\d+\s+(?:days?|hours?|weeks?|months?)\s+ago)/i
      );
      if (dateMatch) {
        publishedAt = dateMatch[1];
      }

      if (isUsableResultUrl(rawUrl)) {
        const canonical = getCanonicalUrl(rawUrl);
        if (!results.some((r) => getCanonicalUrl(r.url) === canonical)) {
          results.push({
            title: title || canonical,
            url: rawUrl,
            snippet,
            publishedAt,
            retrievedAt,
            // Leave extractedContent undefined for search snippets so deepScrapeUrl can fetch full page content
            extractedContent: undefined,
          });
        }
      }
    }

    return results;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Unified Search Tool: Exa (Primary) -> Firecrawl (Secondary) -> Tavily (Tertiary) -> Keyless Fallback
// ---------------------------------------------------------------------------
export const internalWebSearchTool: WebSearchTool = {
  name: 'web_search',
  async execute(input: WebSearchToolInput): Promise<SearchEvidence[]> {
    const query = (input.query || '').trim();
    if (!query) return [];

    const max = Math.min(Math.max(input.maxResults || 5, 1), 10);
    const exaKey = input.searchKeys?.exa || process.env.EXA_API_KEY;
    const firecrawlKey = input.searchKeys?.firecrawl || process.env.FIRECRAWL_API_KEY;
    const tavilyKey = input.searchKeys?.tavily || process.env.TAVILY_API_KEY;

    // 1. Primary: Exa (Semantic neural search + highlights)
    if (exaKey) {
      try {
        const results = await searchWithExa(query, max, input.recency, exaKey);
        if (results.length > 0) return results;
      } catch (err) {
        console.warn('Exa search failed, falling back to Firecrawl:', err);
      }
    }

    // 2. Secondary: Firecrawl (Full JS rendering & markdown tables)
    if (firecrawlKey) {
      try {
        const results = await searchWithFirecrawl(query, max, firecrawlKey);
        if (results.length > 0) return results;
      } catch (err) {
        console.warn('Firecrawl search failed, falling back to Tavily:', err);
      }
    }

    // 3. Fallback: Tavily
    if (tavilyKey) {
      try {
        const results = await searchWithTavily(query, max, input.recency, tavilyKey);
        if (results.length > 0) return results;
      } catch (err) {
        console.warn('Tavily search failed:', err);
      }
    }

    // 4. Resilient Keyless Fallback
    // When no API key is provided, search without failing the turn.
    const fallbackResults = await searchWithKeylessFallback(query, max, input.recency);
    if (fallbackResults.length > 0) {
      return fallbackResults;
    }

    console.warn('No search results returned for query:', query);
    return [];
  },
};
