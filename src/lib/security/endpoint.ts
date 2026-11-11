import { lookup as dnsLookup } from 'node:dns/promises';
import type { SupportedProvider } from '@/types/chat';

export type EndpointCheck =
  | { ok: true; url: string }
  | { ok: false; reason: string };

const LOCAL_PROVIDERS: ReadonlySet<SupportedProvider> = new Set(['ollama', 'local']);

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '[::1]') return true;
  if (host === '0:0:0:0:0:0:0:1' || host === '[0:0:0:0:0:0:0:1]') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host === '0.0.0.0' || host === '[::]') return false;
  return false;
}

function isPrivateOrLinkLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');

  if (isLoopbackHost(host)) return true;
  if (host === '0.0.0.0' || host === '[::]' || host === '::') return true;
  if (host === 'metadata' || host.endsWith('.internal') || host.endsWith('.local')) return true;
  if (host === 'metadata.google.internal') return true;

  // IPv4 private, link-local, CGNAT, and multicast ranges.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  // IPv6 unique-local and link-local literals. URL.hostname may include brackets.
  const v6 = host.replace(/^\[|\]$/g, '');
  if (v6 === '::1' || v6 === '::' || v6 === '0:0:0:0:0:0:0:1') return true;
  if (v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) {
    return true;
  }

  // IPv4-mapped IPv6, in dotted (::ffff:127.0.0.1) or hex (::ffff:7f00:1) form.
  const mappedDotted = v6.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mappedDotted) return isPrivateOrLinkLocalHost(mappedDotted[1]);

  const mappedHex = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateOrLinkLocalHost(
      `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
    );
  }

  return false;
}

/**
 * True when a URL is an HTTP(S) URL whose host is not loopback, private,
 * link-local, or a metadata service. Used before the server fetches a URL
 * supplied by a search provider or the model.
 */
export function isSafeRemoteUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (isPrivateOrLinkLocalHost(parsed.hostname)) return false;
  return true;
}

function isIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

export type HostResolver = (hostname: string) => Promise<string[]>;

const defaultResolver: HostResolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
};

/**
 * Like `isSafeRemoteUrl`, but also resolves the hostname, so a public-looking
 * name that maps to an internal address (for example a `nip.io` wildcard) is
 * rejected before the server connects to it. Literal IPs need no lookup.
 */
export async function isSafeRemoteUrlResolved(
  rawUrl: string,
  resolve: HostResolver = defaultResolver
): Promise<boolean> {
  if (!isSafeRemoteUrl(rawUrl)) return false;

  const hostname = new URL(rawUrl).hostname;
  if (isIpLiteral(hostname)) return true;

  try {
    const addresses = await resolve(hostname);
    return addresses.length > 0 && addresses.every((address) => !isPrivateOrLinkLocalHost(address));
  } catch {
    return false;
  }
}

export function validateCustomBaseUrl(
  rawUrl: string,
  provider: SupportedProvider,
  options?: { allowLoopback?: boolean }
): EndpointCheck {
  // Two separate risks are addressed here:
  //  1. Credential exfiltration: the server must never send an environment API key
  //     to a host chosen by the browser. Callers enforce this separately by requiring
  //     the client to supply its own key whenever a custom URL is used.
  //  2. SSRF: endpoints must not target loopback, private, link-local, or metadata
  //     addresses. Local-only providers may target loopback because that is their
  //     entire purpose; they may not target arbitrary LAN addresses.
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'Custom base URL is not a valid absolute URL.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Custom base URL must use http or https.' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'Custom base URL must not contain credentials.' };
  }

  if (parsed.search || parsed.hash) {
    return { ok: false, reason: 'Custom base URL must not contain a query string or fragment.' };
  }

  const isLocalProvider = LOCAL_PROVIDERS.has(provider);
  const loopback = isLoopbackHost(parsed.hostname);
  const allowLoopback = isLocalProvider || options?.allowLoopback === true;

  if (loopback) {
    if (!allowLoopback) {
      return {
        ok: false,
        reason:
          'Custom base URLs may not target loopback addresses for this provider. Use a local provider for local endpoints.',
      };
    }
  } else if (isLocalProvider) {
    return {
      ok: false,
      reason:
        'Local providers may only use a loopback endpoint (localhost, 127.0.0.1, or ::1).',
    };
  } else if (isPrivateOrLinkLocalHost(parsed.hostname)) {
    return {
      ok: false,
      reason: 'Custom base URL may not target a private, link-local, or metadata address.',
    };
  }

  if (!loopback && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Remote custom base URLs must use https.' };
  }

  return { ok: true, url: parsed.toString().replace(/\/$/, '') };
}
