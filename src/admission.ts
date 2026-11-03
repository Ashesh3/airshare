import { BlockList, isIP } from "node:net";
import { config } from "./config";
import { remoteAddress } from "./http-server";

const trusted = new BlockList();
for (const value of config.trustedProxies.split(",").map((part) => part.trim()).filter(Boolean)) {
  const [address, prefix, extra] = value.split("/");
  const version = isIP(address!);
  if (!version || extra !== undefined) throw new Error("TRUSTED_PROXIES must contain comma-separated IP addresses or CIDRs");
  const family = version === 4 ? "ipv4" : "ipv6";
  if (prefix === undefined) trusted.addAddress(address!, family);
  else {
    if (!/^\d+$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)) throw new Error("Invalid TRUSTED_PROXIES prefix");
    trusted.addSubnet(address!, Number(prefix), family);
  }
}
function normalized(address: string) {
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:") && isIP(lower.slice(7)) === 4) return lower.slice(7);
  return lower;
}
function isTrusted(address: string) { const version = isIP(address); return !!version && trusted.check(address, version === 4 ? "ipv4" : "ipv6"); }
function prefixKey(address: string) {
  if (isIP(address) !== 6) return address;
  // One IPv6 host commonly controls a /64: rotating interface IDs must not
  // bypass client admission. URL canonicalization also normalizes spellings.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split("::");
  const start = left ? left.split(":") : [];
  const end = right ? right.split(":") : [];
  const parts = right !== undefined ? [...start, ...Array(8 - start.length - end.length).fill("0"), ...end] : start;
  return `${parts.slice(0, 4).map((part) => Number.parseInt(part, 16).toString(16)).join(":")}::/64`;
}
const identities = new WeakMap<Request, string>();
export function clientIdentity(request: Request) {
  const existing = identities.get(request);
  if (existing) return existing;
  let address = normalized(remoteAddress(request));
  if (isTrusted(address)) {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",").map((part) => normalized(part.trim()));
    if (forwarded?.length && forwarded.length <= 32 && forwarded.every((part) => isIP(part))) {
      for (let index = forwarded.length - 1; index >= 0 && isTrusted(address); index--) address = forwarded[index]!;
    } else if (!forwarded) {
      const real = request.headers.get("x-real-ip")?.trim();
      if (real && isIP(real)) address = normalized(real);
    }
  }
  const key = prefixKey(address);
  identities.set(request, key);
  return key;
}

const buckets = new Map<string, { tokens: number; updated: number }>();
/** Returns the seconds to wait, or zero when a creation is admitted. */
export function admitCreation(request: Request) {
  if (config.creationBurst === 0) return 0;
  const key = clientIdentity(request);
  const now = performance.now();
  let bucket = buckets.get(key);
  if (bucket) {
    bucket.tokens = Math.min(config.creationBurst, bucket.tokens + (now - bucket.updated) * config.creationBurst / config.creationInterval);
    buckets.delete(key); // Refresh LRU position without an unbounded history.
  } else {
    if (buckets.size >= config.maxCreationBuckets) buckets.delete(buckets.keys().next().value!);
    bucket = { tokens: config.creationBurst, updated: now };
  }
  bucket.updated = now;
  buckets.set(key, bucket);
  if (bucket.tokens < 1) return Math.max(1, Math.ceil((1 - bucket.tokens) * config.creationInterval / config.creationBurst / 1000));
  bucket.tokens--;
  return 0;
}

const resources = { receiver: new Map<string, number>(), subscriber: new Map<string, number>() };
/** Active maps are bounded by the corresponding global resource ceiling. */
export function leaseClient(request: Request, kind: keyof typeof resources) {
  const key = clientIdentity(request);
  const counts = resources[kind];
  const count = counts.get(key) ?? 0;
  const limit = kind === "receiver" ? config.maxReceiversPerClient : config.maxSubscribersPerClient;
  if (count >= limit) return;
  counts.set(key, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (counts.get(key) ?? 1) - 1;
    if (next) counts.set(key, next); else counts.delete(key);
  };
}
