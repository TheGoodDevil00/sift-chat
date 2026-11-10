import type { RawCitationInput, RawSourceInput } from '../citations/normalize';
import { normalizeCitations, normalizeSources } from '../citations/normalize';

export interface NormalizedAgentResponse {
  text: string;
  citations: Array<{
    message_id: string;
    url: string;
    canonical_url: string;
    title: string | null;
    start_index: number | null;
    end_index: number | null;
    source_metadata_json: string | null;
  }>;
  sources: Array<{
    message_id: string;
    url: string;
    canonical_url: string;
    title: string | null;
    source_metadata_json: string | null;
  }>;
  responseId?: string;
  model?: string;
  finishReason?: string;
}

export function parseAndNormalizeResponse(
  responseObj: any,
  assistantMessageId: string
): NormalizedAgentResponse {
  let text = '';
  const rawCitations: RawCitationInput[] = [];
  const rawSources: RawSourceInput[] = [];

  const responseId = responseObj?.id;
  const model = responseObj?.model;
  const finishReason = responseObj?.status || 'completed';

  // Process output items
  const outputItems = Array.isArray(responseObj?.output) ? responseObj.output : [];

  for (const item of outputItems) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === 'text') {
          if (part.text) {
            text += part.text;
          }
          if (Array.isArray(part.annotations)) {
            for (const ann of part.annotations) {
              if (ann.url || ann.type === 'url_citation') {
                rawCitations.push({
                  url: ann.url || ann.citation?.url,
                  title: ann.title || ann.citation?.title || null,
                  start_index: typeof ann.start_index === 'number' ? ann.start_index : null,
                  end_index: typeof ann.end_index === 'number' ? ann.end_index : null,
                  source_metadata_json: JSON.stringify(ann),
                });
              }
            }
          }
        }
      }
    } else if (item.type === 'web_search_call') {
      // Check sources under action.sources or sources or results
      const sourcesList =
        item.action?.sources ||
        item.sources ||
        item.action?.results ||
        item.results ||
        [];

      if (Array.isArray(sourcesList)) {
        for (const s of sourcesList) {
          const url = s.url || s.link;
          if (url) {
            rawSources.push({
              url,
              title: s.title || null,
              source_metadata_json: JSON.stringify(s),
            });
          }
        }
      }
    }
  }

  // Also, any citations extracted can be considered consulted sources
  for (const c of rawCitations) {
    if (c.url) {
      rawSources.push({
        url: c.url,
        title: c.title,
        source_metadata_json: c.source_metadata_json,
      });
    }
  }

  const citations = normalizeCitations(rawCitations, assistantMessageId);
  const sources = normalizeSources(rawSources, assistantMessageId);

  return {
    text,
    citations,
    sources,
    responseId,
    model,
    finishReason,
  };
}
