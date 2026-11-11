import { describe, it, expect } from 'vitest';
import {
  isValidHttpUrl,
  getCanonicalUrl,
  normalizeCitations,
  normalizeSources,
  extractCitationsFromText,
} from '@/lib/citations/normalize';
import { parseAndNormalizeResponse } from '@/lib/agent/response-normalizer';

describe('Citations and Source Normalization', () => {
  it('validates only HTTP and HTTPS schemes', () => {
    expect(isValidHttpUrl('https://stripe.com/pricing')).toBe(true);
    expect(isValidHttpUrl('http://example.com')).toBe(true);
    expect(isValidHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isValidHttpUrl('data:text/html;base64,...')).toBe(false);
    expect(isValidHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isValidHttpUrl('')).toBe(false);
  });

  it('normalizes canonical URLs by stripping tracking params and trailing slashes', () => {
    const raw = 'https://supabase.com/pricing/?utm_source=twitter&utm_medium=social#faq';
    const canonical = getCanonicalUrl(raw);
    expect(canonical).toBe('https://supabase.com/pricing');
  });

  it('deduplicates sources by canonical URL', () => {
    const sources = [
      { url: 'https://hubspot.com/pricing?utm_source=google', title: 'Pricing 1' },
      { url: 'https://hubspot.com/pricing', title: 'Pricing 2' },
      { url: 'https://hubspot.com/about', title: 'About' },
    ];

    const normalized = normalizeSources(sources, 'msg-1');
    expect(normalized.length).toBe(2);
    expect(normalized.map((s) => s.canonical_url)).toEqual([
      'https://hubspot.com/pricing',
      'https://hubspot.com/about',
    ]);
  });

  it('parses Responses API structure with annotations and web_search_call sources', () => {
    const mockResponse = {
      id: 'resp-test-999',
      model: 'gpt-4o',
      status: 'completed',
      output: [
        {
          type: 'web_search_call',
          action: {
            sources: [
              { url: 'https://close.com/pricing', title: 'Close CRM Pricing' },
              { url: 'https://pipedrive.com/pricing', title: 'Pipedrive Pricing' },
            ],
          },
        },
        {
          type: 'message',
          content: [
            {
              type: 'text',
              text: 'Close CRM pricing starts at $49/user/month [1]. Pipedrive starts at $14 [2].',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://close.com/pricing',
                  title: 'Close CRM Pricing',
                  start_index: 43,
                  end_index: 46,
                },
                {
                  type: 'url_citation',
                  url: 'https://pipedrive.com/pricing',
                  title: 'Pipedrive Pricing',
                  start_index: 73,
                  end_index: 76,
                },
              ],
            },
          ],
        },
      ],
    };

    const parsed = parseAndNormalizeResponse(mockResponse, 'msg-assistant-1');
    expect(parsed.text).toContain('Close CRM pricing starts at $49');
    expect(parsed.citations.length).toBe(2);
    expect(parsed.citations[0].url).toBe('https://close.com/pricing');
    expect(parsed.citations[0].start_index).toBe(43);
    expect(parsed.sources.length).toBe(2);
  });

  it('extracts bare URLs and markdown links, stripping trailing punctuation and validating against consulted evidence', () => {
    const text = 'Supabase Pro costs $25/month according to https://supabase.com/pricing. Also see [Neon Pricing](https://neon.tech/pricing) and unconsulted https://fake-news-scam.com.';
    const consulted = [
      { url: 'https://supabase.com/pricing', title: 'Supabase Pricing' },
      { url: 'https://neon.tech/pricing', title: 'Neon Serverless Postgres Pricing' },
    ];

    const citations = extractCitationsFromText(text, 'msg-1', consulted);
    expect(citations.length).toBe(2);
    expect(citations.map((c) => c.canonical_url)).toEqual([
      'https://neon.tech/pricing',
      'https://supabase.com/pricing',
    ]);
    expect(citations.find((c) => c.canonical_url.includes('supabase.com'))?.url).toBe('https://supabase.com/pricing');
    expect(citations.some((c) => c.url.includes('fake-news-scam'))).toBe(false);
  });

  it('drops every citation when no evidence was consulted, including plausible domain matches', () => {
    const text =
      'According to [HubSpot Pricing](https://hubspot.com/pricing) and https://close.com/pricing, prices changed.';

    // The agent did not actually retrieve these URLs this turn.
    expect(extractCitationsFromText(text, 'msg-empty', [])).toEqual([]);

    // A different page on a consulted domain is not grounded either.
    const domainOnly = extractCitationsFromText(text, 'msg-domain', [
      { url: 'https://hubspot.com/blog', title: 'HubSpot Blog' },
    ]);
    expect(domainOnly).toEqual([]);
  });
});
