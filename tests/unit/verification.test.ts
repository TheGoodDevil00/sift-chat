import { describe, it, expect } from 'vitest';
import {
  parseVerificationReport,
  formatVerificationTable,
} from '@/lib/agent/verification';

const validReport = {
  summary: 'HubSpot pricing changed; Close is unchanged.',
  claims: [
    {
      entity: 'HubSpot',
      attribute: 'Starter price',
      previous_value: '$20',
      current_value: '$25',
      status: 'confirmed_change',
      source_url: 'https://hubspot.com/pricing',
      effective_date: '2026-11-01',
    },
    {
      entity: 'Close',
      attribute: 'Starter price',
      previous_value: '$49',
      current_value: '$49',
      status: 'still_supported',
      source_url: 'https://close.com/pricing',
    },
  ],
};

describe('Verification report parsing', () => {
  it('parses a fenced JSON report wrapped in prose', () => {
    const text = `Here is the report:\n\n\`\`\`json\n${JSON.stringify(validReport)}\n\`\`\`\n\nLet me know if you need more.`;
    const parsed = parseVerificationReport(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.claims).toHaveLength(2);
    expect(parsed?.claims[0].entity).toBe('HubSpot');
  });

  it('parses a bare JSON object with surrounding prose', () => {
    const parsed = parseVerificationReport(`Result: ${JSON.stringify(validReport)} done.`);
    expect(parsed?.claims).toHaveLength(2);
  });

  it('drops invalid claims and invalid source URLs', () => {
    const parsed = parseVerificationReport(
      JSON.stringify({
        summary: 'Mixed quality.',
        claims: [
          { entity: 'A', attribute: 'Price', status: 'not_a_status' },
          { entity: '', attribute: 'Price', status: 'still_supported' },
          {
            entity: 'B',
            attribute: 'Price',
            status: 'still_supported',
            source_url: 'javascript:alert(1)',
          },
        ],
      })
    );

    expect(parsed?.claims).toHaveLength(1);
    expect(parsed?.claims[0].entity).toBe('B');
    expect(parsed?.claims[0].source_url).toBeUndefined();
  });

  it('returns null when no valid claims remain or fields are missing', () => {
    expect(parseVerificationReport('no json here')).toBeNull();
    expect(parseVerificationReport(JSON.stringify({ summary: 'x', claims: [] }))).toBeNull();
    expect(parseVerificationReport(JSON.stringify({ claims: validReport.claims }))).toBeNull();
  });

  it('escapes pipes and newlines so the generated table cannot be broken', () => {
    const report = {
      summary: 'Summary',
      claims: [
        {
          entity: 'Acme | Corp',
          attribute: 'Plan\nname',
          status: 'unable_to_verify' as const,
          source_url: 'https://example.com/pricing?x=1',
          effective_date: '2026-11-01',
        },
      ],
    };

    const markdown = formatVerificationTable(report);
    expect(markdown).toContain('Acme \\| Corp');
    expect(markdown).toContain('Plan name');
    expect(markdown).toContain('https://example.com/pricing?x=1');
  });
});
