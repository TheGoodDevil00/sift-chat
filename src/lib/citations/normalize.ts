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
  const seenCanonical = new Set<string>();

  for (const c of citations) {
    if (!c.url || !isValidHttpUrl(c.url)) continue;

    const canonical = getCanonicalUrl(c.url);
    if (seenCanonical.has(canonical)) continue;
    seenCanonical.add(canonical);

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
 * Finds [label](url) markdown links AND bare URLs (e.g. https://supabase.com/pricing).
 * Verifies valid HTTP(S), strips trailing punctuation, and validates grounding against consulted evidence.
 */
export function extractCitationsFromText(
  text: string,
  messageId: string,
  consultedEvidence?: Array<{ url: string; title?: string }>
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
  const occupiedRanges: Array<{ start: number; end: number }> = [];

  // A. Extract markdown links [label](url)
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(text)) !== null) {
    const title = match[1].trim();
    const url = match[2].trim();
    const start_index = match.index;
    const end_index = match.index + match[0].length;
    occupiedRanges.push({ start: start_index, end: end_index });

    if (isValidHttpUrl(url)) {
      rawCitations.push({
        url,
        title,
        start_index,
        end_index,
        source_metadata_json: JSON.stringify({ type: 'markdown_link', match: match[0] }),
      });
    }
  }

  // B. Extract bare URLs (e.g. https://supabase.com/pricing)
  const bareUrlRegex = /\bhttps?:\/\/[^\s<>"'{}|\\^`\[\]]+/g;
  let bareMatch: RegExpExecArray | null;

  while ((bareMatch = bareUrlRegex.exec(text)) !== null) {
    const startIndex = bareMatch.index;
    const rawMatchText = bareMatch[0];

    // Check if this falls inside any markdown link already extracted
    const isInsideMarkdownLink = occupiedRanges.some(
      (r) => startIndex >= r.start && startIndex < r.end
    );
    if (isInsideMarkdownLink) continue;

    // Clean trailing punctuation like ., ;, ), ], etc.
    const cleanUrl = rawMatchText.replace(/[.,;:!?)\]'">]+$/, '');
    const endIndex = startIndex + cleanUrl.length;

    if (isValidHttpUrl(cleanUrl)) {
      rawCitations.push({
        url: cleanUrl,
        title: cleanUrl.replace(/^https?:\/\/(www\.)?/, ''),
        start_index: startIndex,
        end_index: endIndex,
        source_metadata_json: JSON.stringify({ type: 'bare_url', match: cleanUrl }),
      });
    }
  }

  // C. Normalize and Validate against Consulted Evidence
  const normalized = normalizeCitations(rawCitations, messageId);

  // When the caller supplied evidence (even an empty list), grounding is strict:
  // every returned citation must correspond to a URL the agent actually retrieved.
  // A plausible-looking URL invented by the model is not a citation.
  if (consultedEvidence !== undefined) {
    const consultedMap = new Map<string, { url: string; title?: string }>();
    for (const ev of consultedEvidence) {
      if (ev.url) {
        consultedMap.set(getCanonicalUrl(ev.url), ev);
      }
    }

    const groundedList = [];
    for (const cit of normalized) {
      const matchInEvidence = consultedMap.get(cit.canonical_url);
      if (!matchInEvidence) continue;

      let originalMetadata: Record<string, unknown> = {};
      if (cit.source_metadata_json) {
        try {
          const parsed = JSON.parse(cit.source_metadata_json);
          if (parsed && typeof parsed === 'object') originalMetadata = parsed;
        } catch {
          // Keep malformed metadata out of the grounded record rather than dropping the citation.
        }
      }

      groundedList.push({
        ...cit,
        title: cit.title || matchInEvidence.title || null,
        source_metadata_json: JSON.stringify({
          ...originalMetadata,
          grounded: true,
          verifiedAgainstConsultedEvidence: true,
          evidenceUrl: matchInEvidence.url,
        }),
      });
    }

    return groundedList;
  }

  return normalized;
}
