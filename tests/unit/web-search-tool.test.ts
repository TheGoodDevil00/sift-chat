import { describe, it, expect } from 'vitest';
import {
  internalWebSearchTool,
  webSearchToolSchema,
  type SearchEvidence,
} from '@/lib/agent/tools/web-search';

describe('WebSearchTool execution and schema', () => {
  it('has name web_search and correct schema', () => {
    expect(internalWebSearchTool.name).toBe('web_search');
    expect(webSearchToolSchema.name).toBe('web_search');
    expect(webSearchToolSchema.parameters.required).toContain('query');
  });

  it('validates empty queries gracefully returning empty evidence', async () => {
    const res = await internalWebSearchTool.execute({ query: '   ' });
    expect(Array.isArray(res)).toBe(true);
    expect(res.length).toBe(0);
  });

  it('conforms to SearchEvidence shape when executing queries', async () => {
    const evidenceList: SearchEvidence[] = await internalWebSearchTool.execute({
      query: 'Postgres official pricing',
      maxResults: 3,
    });

    expect(Array.isArray(evidenceList)).toBe(true);
    if (evidenceList.length > 0) {
      const item = evidenceList[0];
      expect(item.title).toBeDefined();
      expect(item.url).toBeDefined();
      expect(item.retrievedAt).toBeDefined();
      expect(item.url.startsWith('http')).toBe(true);
    }
  });
});
