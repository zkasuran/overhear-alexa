// Alexa request verification for a self-hosted skill endpoint, following the Alexa Skills Kit rules for
// HTTPS endpoints: the signing certificate URL must be an Amazon S3 echo.api path over https:443, the
// certificate must be valid now, name echo-api.amazon.com and chain to a trusted root, the
// Signature-256 header must verify over the raw body with that certificate (RSA SHA-256), and the
// request timestamp must be within 150 seconds. Node's crypto does all of it, so no extra dependency.

import { X509Certificate, createVerify } from "node:crypto";
import { rootCertificates } from "node:tls";

const MAX_SKEW_MS = 150_000;
const CERT_FETCH_TIMEOUT_MS = 5_000;
const MAX_CERT_BYTES = 64 * 1024;

export class VerifyError extends Error {}

/** The certificate-URL rules from the ASK docs, after normalising the path. */
export function certUrlOk(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    u.hostname.toLowerCase() === "s3.amazonaws.com" &&
    (u.port === "" || u.port === "443") &&
    u.pathname.startsWith("/echo.api/")
  );
}

export function timestampOk(iso: unknown, now: number): boolean {
  if (typeof iso !== "string") return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && Math.abs(now - t) <= MAX_SKEW_MS;
}

const ROOTS = rootCertificates.map((pem) => new X509Certificate(pem));
const certCache = new Map<string, { leaf: X509Certificate; expires: number }>();

function splitPem(pem: string): X509Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((b) => new X509Certificate(b));
}

function chainOk(chain: X509Certificate[], now: number): boolean {
  if (chain.length === 0) return false;
  for (const c of chain) {
    if (Date.parse(c.validFrom) > now || Date.parse(c.validTo) < now) return false;
  }
  for (let i = 0; i < chain.length - 1; i++) {
    const child = chain[i];
    const parent = chain[i + 1];
    if (!child || !parent || !child.checkIssued(parent) || !child.verify(parent.publicKey))
      return false;
  }
  const top = chain[chain.length - 1];
  if (!top) return false;
  return ROOTS.some(
    (r) =>
      r.fingerprint256 === top.fingerprint256 || (top.checkIssued(r) && top.verify(r.publicKey)),
  );
}

async function leafFor(url: string, now: number): Promise<X509Certificate> {
  const hit = certCache.get(url);
  if (hit && hit.expires > now) return hit.leaf;
  const res = await fetch(url, { signal: AbortSignal.timeout(CERT_FETCH_TIMEOUT_MS) });
  const pem = await res.text();
  if (!res.ok || pem.length > MAX_CERT_BYTES) throw new VerifyError("certificate fetch failed");
  const chain = splitPem(pem);
  const leaf = chain[0];
  if (!leaf || !chainOk(chain, now)) throw new VerifyError("certificate chain invalid");
  if (!(leaf.subjectAltName ?? "").split(/,\s*/).includes("DNS:echo-api.amazon.com")) {
    throw new VerifyError("certificate is not for echo-api.amazon.com");
  }
  certCache.set(url, { leaf, expires: Math.min(Date.parse(leaf.validTo), now + 3_600_000) });
  return leaf;
}

/** Throws VerifyError unless the request is a genuine, fresh Alexa request. */
export async function verifyAlexaRequest(
  rawBody: string,
  headers: { certUrl: string | undefined; signature256: string | undefined },
  timestamp: unknown,
  now = Date.now(),
): Promise<void> {
  if (!headers.certUrl || !certUrlOk(headers.certUrl)) throw new VerifyError("bad certificate url");
  if (!headers.signature256) throw new VerifyError("missing signature");
  if (!timestampOk(timestamp, now)) throw new VerifyError("stale or missing timestamp");
  const leaf = await leafFor(headers.certUrl, now);
  const v = createVerify("RSA-SHA256");
  v.update(rawBody, "utf8");
  if (!v.verify(leaf.publicKey, headers.signature256, "base64")) {
    throw new VerifyError("signature does not verify");
  }
}
