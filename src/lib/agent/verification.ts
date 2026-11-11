import { isValidHttpUrl } from '../citations/normalize';

export type ClaimStatus =
  | 'confirmed_change'
  | 'differs_from_baseline'
  | 'still_supported'
  | 'no_change_found'
  | 'unable_to_verify';

export interface ClaimVerificationItem {
  entity: string;
  attribute: string;
  previous_value?: string;
  current_value?: string;
  status: ClaimStatus;
  source_url?: string;
  effective_date?: string;
  confidence_note?: string;
}

export interface VerificationReport {
  claims: ClaimVerificationItem[];
  summary: string;
}

export const verificationSchema = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      description: 'Structured list of claims and verification statuses',
      items: {
        type: 'object',
        properties: {
          entity: { type: 'string', description: 'Product or service name (e.g. HubSpot, Supabase)' },
          attribute: { type: 'string', description: 'What was checked (e.g., "Starter plan price", "Compute limits")' },
          previous_value: { type: 'string', description: 'Value from prior conversation' },
          current_value: { type: 'string', description: 'Value from current web evidence' },
          status: {
            type: 'string',
            enum: [
              'confirmed_change',
              'differs_from_baseline',
              'still_supported',
              'no_change_found',
              'unable_to_verify',
            ],
            description:
              'confirmed_change: verified with effective date; differs_from_baseline: price/features differ but change date unconfirmed; still_supported: matches prior and still valid; no_change_found: targeted search found no change; unable_to_verify: evidence insufficient or inconclusive',
          },
          source_url: { type: 'string', description: 'Authoritative URL supporting this finding' },
          effective_date: { type: 'string', description: 'When the change took effect, if known' },
          confidence_note: { type: 'string', description: 'Notes on caveats, billing frequency (annual vs monthly), etc.' },
        },
        required: ['entity', 'attribute', 'status'],
      },
    },
    summary: { type: 'string', description: 'Natural language summary of findings and comparison' },
  },
  required: ['claims', 'summary'],
};

const VALID_STATUSES = new Set<ClaimStatus>([
  'confirmed_change',
  'differs_from_baseline',
  'still_supported',
  'no_change_found',
  'unable_to_verify',
]);

const statusLabels: Record<ClaimStatus, string> = {
  confirmed_change: 'Confirmed Change',
  differs_from_baseline: 'Differs from Prior',
  still_supported: 'Still Supported',
  no_change_found: 'No Change Found',
  unable_to_verify: 'Unable to Verify',
};

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function escapeTableCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function safeLinkDestination(url: string): string {
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/</g, '%3C').replace(/>/g, '%3E');
}

/**
 * Validate a parsed object and normalise it into a report we are willing to render.
 * Invalid claims are dropped rather than rendered with missing or untrusted fields.
 */
function validateReport(obj: any): VerificationReport | null {
  if (!obj || typeof obj !== 'object') return null;
  if (!Array.isArray(obj.claims) || typeof obj.summary !== 'string') return null;

  const claims: ClaimVerificationItem[] = [];
  for (const raw of obj.claims) {
    if (!raw || typeof raw !== 'object') continue;
    const entity = optionalString(raw.entity);
    const attribute = optionalString(raw.attribute);
    const status = optionalString(raw.status) as ClaimStatus | undefined;
    if (!entity || !attribute || !status || !VALID_STATUSES.has(status)) continue;

    const sourceUrl = optionalString(raw.source_url);
    const claim: ClaimVerificationItem = {
      entity,
      attribute,
      status,
    };

    const previousValue = optionalString(raw.previous_value);
    const currentValue = optionalString(raw.current_value);
    const effectiveDate = optionalString(raw.effective_date);
    const confidenceNote = optionalString(raw.confidence_note);

    if (previousValue) claim.previous_value = previousValue;
    if (currentValue) claim.current_value = currentValue;
    if (effectiveDate) claim.effective_date = effectiveDate;
    if (confidenceNote) claim.confidence_note = confidenceNote;
    // A source link is only kept when it is a real HTTP(S) URL. The runner's
    // citation extractor will additionally ground it against retrieved evidence.
    if (sourceUrl && isValidHttpUrl(sourceUrl)) claim.source_url = sourceUrl;

    claims.push(claim);
  }

  if (claims.length === 0) return null;

  return {
    claims,
    summary: obj.summary.trim(),
  };
}

/**
 * Format structured verification report into a clean markdown table.
 */
export function formatVerificationTable(report: VerificationReport): string {
  if (!report.claims || report.claims.length === 0) {
    return report.summary;
  }

  const rows: string[] = [
    '| Entity | Attribute | Prior Stated | Current Value | Status | Source & Effective Date |',
    '|---|---|---|---|---|---|',
  ];

  for (const c of report.claims) {
    const prior = escapeTableCell(c.previous_value || '—');
    const current = escapeTableCell(c.current_value || '—');
    const statusText = statusLabels[c.status] || 'Unable to Verify';
    const effectiveDate = escapeTableCell(c.effective_date || '');

    let sourceCol = '—';
    if (c.source_url && isValidHttpUrl(c.source_url)) {
      const displayUrl = escapeTableCell(
        c.source_url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)
      );
      sourceCol = `[${displayUrl}](${safeLinkDestination(c.source_url)})`;
      if (effectiveDate) {
        sourceCol += ` (${effectiveDate})`;
      }
    } else if (effectiveDate) {
      sourceCol = effectiveDate;
    }

    rows.push(
      `| **${escapeTableCell(c.entity)}** | ${escapeTableCell(c.attribute)} | ${prior} | ${current} | ${statusText} | ${sourceCol} |`
    );
  }

  return `${report.summary}\n\n### Claim Verification Details\n\n${rows.join('\n')}`;
}

/**
 * Extract the first balanced JSON object from text. Models often wrap the
 * report in prose or a Markdown code fence; a plain JSON.parse is not enough.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

export function parseVerificationReport(jsonStr: string): VerificationReport | null {
  const trimmed = jsonStr.trim();
  if (!trimmed) return null;

  const candidates: string[] = [];
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) candidates.push(fenceMatch[1].trim());
  candidates.push(trimmed);

  const extracted = extractFirstJsonObject(trimmed);
  if (extracted) candidates.push(extracted);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const report = validateReport(parsed);
      if (report) return report;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}
