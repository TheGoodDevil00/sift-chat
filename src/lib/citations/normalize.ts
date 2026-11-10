export function isValidHttpUrl(urlStr: string): boolean {
  if (!urlStr || typeof urlStr !== 'string') return false;
  try {
    const parsed = new URL(urlStr);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'fbclid',
  'gclid',
  'msclkid',
  '_hsenc',
  '_hsmi',
]);

/**
 * Computes a normalized canonical URL for deduplication.
 */
export function getCanonicalUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hostname = parsed.hostname.toLowerCase();

    const toDelete: string[] = [];
    parsed.searchParams.forEach((_, key) => {
      if (TRACKING_PARAMS.has(key.toLowerCase()) || key.startsWith('utm_')) {
        toDelete.push(key);
      }
    });
    for (const k of toDelete) {
      parsed.searchParams.delete(k);
    }

    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    parsed.hash = '';
    return parsed.toString();
  } catch {
    return rawUrl.trim();
  }
}

export interface RawCitationInput {
  url: string;
  title?: string | null;
  start_index?: number | null;
  end_index?: number | null;
  source_metadata_json?: string | null;
}

export function normalizeCitations(
  citations: RawCitationInput[],
  messageId: string
): Array<{
  message_id: string;
  url: string;
  canonical_url: string;
  title: string | null;
  start_index: number | null;
  end_index: number | null;
  source_metadata_json: string | null;
}> {
  const result = [];

  for (const c of citations) {
    if (!c.url || !isValidHttpUrl(c.url)) continue;

    const canonical = getCanonicalUrl(c.url);
    result.push({
      message_id: messageId,
      url: c.url.trim(),
      canonical_url: canonical,
      title: c.title?.trim() || null,
      start_index: typeof c.start_index === 'number' ? c.start_index : null,
      end_index: typeof c.end_index === 'number' ? c.end_index : null,
      source_metadata_json: c.source_metadata_json || null,
    });
  }

  return result;
}

export interface RawSourceInput {
  url: string;
  title?: string | null;
  source_metadata_json?: string | null;
}

export function normalizeSources(
  sources: RawSourceInput[],
  messageId: string
): Array<{
  message_id: string;
  url: string;
  canonical_url: string;
  title: string | null;
  source_metadata_json: string | null;
}> {
  const seenCanonical = new Set<string>();
  const result = [];

  for (const s of sources) {
    if (!s.url || !isValidHttpUrl(s.url)) continue;

    const canonical = getCanonicalUrl(s.url);
    if (seenCanonical.has(canonical)) continue;
    seenCanonical.add(canonical);

    result.push({
      message_id: messageId,
      url: s.url.trim(),
      canonical_url: canonical,
      title: s.title?.trim() || null,
      source_metadata_json: s.source_metadata_json || null,
    });
  }

  return result;
}

/**
 * Extracts and validates citations directly from assistant markdown answer text.
 * Finds [label](url) links, verifies valid HTTP(S), and records start/end character offsets.
 */
export function extractCitationsFromText(
  text: string,
  messageId: string
): Array<{
  message_id: string;
  url: string;
  canonical_url: string;
  title: string | null;
  start_index: number | null;
  end_index: number | null;
  source_metadata_json: string | null;
}> {
  const rawCitations: RawCitationInput[] = [];
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(text)) !== null) {
    const title = match[1].trim();
    const url = match[2].trim();
    const start_index = match.index;
    const end_index = match.index + match[0].length;

    if (isValidHttpUrl(url)) {
      rawCitations.push({
        url,
        title,
        start_index,
        end_index,
        source_metadata_json: JSON.stringify({ match: match[0] }),
      });
    }
  }

  return normalizeCitations(rawCitations, messageId);
}
