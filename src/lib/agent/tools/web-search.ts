import { isValidHttpUrl, getCanonicalUrl } from '../../citations/normalize';

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
        description: 'The focused search query (e.g. "HubSpot Sales Hub pricing 2026", "Neon Postgres pricing changelog")',
      },
      recency: {
        type: 'string',
        enum: ['day', 'week', 'month', 'any'],
        description: 'Filter search by recency to isolate changes since a previous date',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of evidence results to return (default: 6)',
      },
    },
    required: ['query'],
  },
};

/**
 * Internal web_search tool implementation conforming to WebSearchTool.
 */
export const internalWebSearchTool: WebSearchTool = {
  name: 'web_search',
  async execute(input: WebSearchToolInput): Promise<SearchEvidence[]> {
    const cleanQuery = (input.query || '').trim();
    if (!cleanQuery) return [];

    const maxResults = Math.min(Math.max(input.maxResults || 6, 1), 10);
    const retrievedAt = new Date().toISOString();

    let recencyParam = '';
    if (input.recency === 'day') recencyParam = '&df=d';
    else if (input.recency === 'week') recencyParam = '&df=w';
    else if (input.recency === 'month') recencyParam = '&df=m';

    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}${recencyParam}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        signal: AbortSignal.timeout(12000),
      });

      if (!response.ok) {
        console.warn(`Web search HTTP error: status ${response.status}`);
        return [];
      }

      const html = await response.text();
      const results: SearchEvidence[] = [];

      const resultBlockRegex = /<div class="result__body">([\s\S]*?)<\/div>/g;
      let match: RegExpExecArray | null;

      while ((match = resultBlockRegex.exec(html)) !== null && results.length < maxResults) {
        const block = match[1];

        const headingMatch = block.match(
          /<h2 class="result__title">[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
        );
        const titleMatch =
          headingMatch ||
          block.match(/<a class="result__url"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i) ||
          block.match(/href="\/\/duckduckgo\.com\/l\/\?uddg=([^"&]+)[^"]*"/i);

        let rawUrl = '';
        let title = '';

        if (headingMatch) {
          rawUrl = headingMatch[1];
          title = headingMatch[2].replace(/<[^>]+>/g, '').trim();
        } else if (titleMatch) {
          rawUrl = titleMatch[1];
        }

        if (rawUrl.includes('uddg=')) {
          try {
            const matchUddg = rawUrl.match(/uddg=([^&]+)/);
            if (matchUddg) {
              rawUrl = decodeURIComponent(matchUddg[1]);
            }
          } catch {}
        }

        const snippetMatch = block.match(/<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
        const snippet = snippetMatch
          ? snippetMatch[1].replace(/<[^>]+>/g, '').trim()
          : '';

        // Attempt to detect date from snippet (e.g. "Nov 3, 2026 ...", "3 days ago ...")
        let publishedAt: string | null = null;
        const dateMatch = snippet.match(/^([A-Za-z]{3}\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3}\s+\d{4}|\d+\s+(?:days?|hours?|weeks?|months?)\s+ago)/i);
        if (dateMatch) {
          publishedAt = dateMatch[1];
        }

        if (rawUrl && isValidHttpUrl(rawUrl)) {
          const canonical = getCanonicalUrl(rawUrl);
          if (!results.some((r) => getCanonicalUrl(r.url) === canonical)) {
            results.push({
              title: title || canonical,
              url: rawUrl,
              snippet,
              publishedAt,
              retrievedAt,
              extractedContent: snippet ? `Source excerpt: ${snippet}` : undefined,
            });
          }
        }
      }

      return results;
    } catch (err) {
      console.warn('internalWebSearchTool execution failed:', err);
      return [];
    }
  },
};
