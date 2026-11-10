import { BlockList, isIP } from "node:net";
import type { Config } from "./config";
import { remoteAddress } from "./http-server";

function trustedProxies(config: Config) {
  const trusted = new BlockList();
  for (const value of config.trustedProxies
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const [address, prefix, extra] = value.split("/");
    const version = isIP(address!);
    if (!version || extra !== undefined)
      throw new Error("TRUSTED_PROXIES must contain comma-separated IP addresses or CIDRs");
    const family = version === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) trusted.addAddress(address!, family);
    else {
      if (!/^\d+$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128))
        throw new Error("Invalid TRUSTED_PROXIES prefix");
      trusted.addSubnet(address!, Number(prefix), family);
    }
  }
  return trusted;
}
/** A zone (fe80::1%eth0) names the relay's interface, not the client, and URL parsing rejects it. */
function normalized(address: string) {
  const lower = address.toLowerCase().replace(/%.*$/, "");
  if (lower.startsWith("::ffff:") && isIP(lower.slice(7)) === 4) return lower.slice(7);
  return lower;
}
/** Proxies may write a hop as ip:port or [v6]:port; the port doesn't identify the client. */
function forwardedAddress(entry: string) {
  const value = entry.trim();
  const bracketed = value.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return normalized(bracketed[1]!);
  return normalized(value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/)?.[1] ?? value);
}
function prefixKey(address: string) {
  if (isIP(address) !== 6) return address;
  // One IPv6 host commonly controls a /64: rotating interface IDs must not
  // bypass client admission. URL canonicalization also normalizes spellings.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split("::");
  const start = left ? left.split(":") : [];
  const end = right ? right.split(":") : [];
  const parts = right !== undefined ? [...start, ...Array(8 - start.length - end.length).fill("0"), ...end] : start;
  return `${parts
    .slice(0, 4)
    .map((part) => Number.parseInt(part, 16).toString(16))
    .join(":")}::/64`;
}

export type Admission = ReturnType<typeof createAdmission>;
/** Client identity, the creation rate limit and per-client leases for one relay. */
export function createAdmission(config: Config) {
  const trusted = trustedProxies(config);
  const isTrusted = (address: string) => {
    const version = isIP(address);
    return !!version && trusted.check(address, version === 4 ? "ipv4" : "ipv6");
  };
  /** Whether forwarding headers on this request were written by a configured proxy. */
  const viaTrustedProxy = (request: Request) => isTrusted(normalized(remoteAddress(request)));
  const identities = new WeakMap<Request, string>();
  const clientIdentity = (request: Request) => {
    const existing = identities.get(request);
    if (existing) return existing;
    let address = normalized(remoteAddress(request));
    if (isTrusted(address)) {
      const forwarded = request.headers.get("x-forwarded-for")?.split(",").map(forwardedAddress);
      if (forwarded) {
        // Hops left of the nearest untrusted one are client-written: a malformed or overlong prefix only ends the walk.
        for (
          let index = forwarded.length - 1, hops = 0;
          index >= 0 && hops < 32 && isTrusted(address) && isIP(forwarded[index]!);
          index--, hops++
        ) {
          address = forwarded[index]!;
        }
      } else {
        const real = request.headers.get("x-real-ip");
        if (real !== null && isIP(forwardedAddress(real))) address = forwardedAddress(real);
      }
    }
    const key = prefixKey(address);
    identities.set(request, key);
    return key;
  };

  const buckets = new Map<string, { tokens: number; updated: number }>();
  /** Returns the seconds to wait, or zero when a creation is admitted. */
  const admitCreation = (request: Request) => {
    if (config.creationBurst === 0) return 0;
    const key = clientIdentity(request);
    const now = performance.now();
    let bucket = buckets.get(key);
    if (bucket) {
      bucket.tokens = Math.min(
        config.creationBurst,
        bucket.tokens + ((now - bucket.updated) * config.creationBurst) / config.creationInterval,
      );
      buckets.delete(key); // Refresh LRU position without an unbounded history.
    } else {
      if (buckets.size >= config.maxCreationBuckets) buckets.delete(buckets.keys().next().value!);
      bucket = { tokens: config.creationBurst, updated: now };
    }
    bucket.updated = now;
    buckets.set(key, bucket);
    if (bucket.tokens < 1)
      return Math.max(1, Math.ceil(((1 - bucket.tokens) * config.creationInterval) / config.creationBurst / 1000));
    bucket.tokens--;
    return 0;
  };

  const resources = {
    receiver: new Map<string, number>(),
    subscriber: new Map<string, number>(),
    upload: new Map<string, number>(),
  };
  const limits = {
    receiver: config.maxReceiversPerClient,
    subscriber: config.maxSubscribersPerClient,
    upload: config.maxUploadsPerClient,
  };
  /** Active maps are bounded by the corresponding global resource ceiling. */
  const leaseClient = (request: Request, kind: keyof typeof resources) => {
    const key = clientIdentity(request);
    const counts = resources[kind];
    const count = counts.get(key) ?? 0;
    if (count >= limits[kind]) return;
    counts.set(key, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (counts.get(key) ?? 1) - 1;
      if (next) counts.set(key, next);
      else counts.delete(key);
    };
  };
  return { viaTrustedProxy, clientIdentity, admitCreation, leaseClient };
}
