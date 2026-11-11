/**
 * Concurrency limiter / semaphore to cap concurrent deep scrapes.
 * Prevents bursting 5+ simultaneous full DOM renders or plain fetches
 * when models emit multi-tool parallel searches.
 */
import { isSafeRemoteUrlResolved } from '../../security/endpoint';

class AsyncSemaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    return () => this.release();
  }

  private release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const scrapeSemaphore = new AsyncSemaphore(2);

/**
 * Deep-scrape a specific URL using Firecrawl's Chromium renderer.
 * Use this for JS-heavy pricing pages, changelogs, etc. where
 * the search snippet isn't enough and you need the actual rendered content.
 *
 * Costs 1 Firecrawl credit per page (free tier: 1000/month).
 */
export async function deepScrapeUrl(
  url: string,
  maxChars = 6000,
  customApiKey?: string
): Promise<string | null> {
  // Never let a search result or model-supplied URL reach an internal address.
  if (!(await isSafeRemoteUrlResolved(url))) return null;

  const release = await scrapeSemaphore.acquire();
  try {
    return await executeDeepScrape(url, maxChars, customApiKey);
  } finally {
    release();
  }
}

async function executeDeepScrape(
  url: string,
  maxChars = 6000,
  customApiKey?: string
): Promise<string | null> {
  const apiKey = customApiKey || process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    // Fall back to plain fetch + HTML stripping if no Firecrawl key
    return plainFetchExtract(url, maxChars);
  }

  try {
    const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        waitFor: 2000, // wait 2s for JS rendering
        timeout: 10000,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return plainFetchExtract(url, maxChars);
    }

    const json = await res.json();
    const markdown = json.data?.markdown || json.markdown || '';
    if (markdown) {
      return markdown.slice(0, maxChars);
    }

    return plainFetchExtract(url, maxChars);
  } catch {
    return plainFetchExtract(url, maxChars);
  }
}

/**
 * Fetch a URL while following redirects manually so every hop is validated.
 * `redirect: 'follow'` would let a public URL bounce the server to 169.254.169.254
 * or another internal address before we could inspect the final URL.
 */
async function fetchWithSafeRedirects(
  url: string,
  init: RequestInit,
  maxRedirects = 3
): Promise<Response | null> {
  let current = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    // Resolve every hop, so neither the initial URL nor a redirect can point
    // at the host's own network (including wildcard DNS names that resolve there).
    if (!(await isSafeRemoteUrlResolved(current))) return null;

    const res = await fetch(current, { ...init, redirect: 'manual' });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return null;
      current = new URL(location, current).toString();
      continue;
    }

    return res;
  }

  return null;
}

async function plainFetchExtract(url: string, maxChars: number): Promise<string | null> {
  try {
    const res = await fetchWithSafeRedirects(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res || !res.ok) return null;

    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return text.slice(0, maxChars) || null;
  } catch {
    return null;
  }
}
