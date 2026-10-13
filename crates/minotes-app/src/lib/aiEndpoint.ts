/**
 * "Local model" endpoints that are not on this computer (mirror of
 * minotes-core `ai::settings::{endpoint_host, is_loopback_host}`).
 *
 * A loopback endpoint (localhost, 127.0.0.0/8, ::1) keeps notes on this
 * device. Anything else is a custom endpoint: notes leave the device, so the
 * user must confirm that host explicitly (`local.confirmed_remote_host`)
 * before the backend accepts or uses it.
 */

/** Host of an http(s) URL, lower-cased, without brackets or port. */
export function endpointHost(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const h = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    return h || null;
  } catch {
    return null;
  }
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === "::1"
    || /^::ffff:(127\.|7f[0-9a-f]{2}:)/.test(h);
}

/** The endpoint's host when it is NOT on this computer, else null. */
export function remoteHost(baseUrl: string): string | null {
  const h = endpointHost(baseUrl);
  return h && !isLoopbackHost(h) ? h : null;
}
