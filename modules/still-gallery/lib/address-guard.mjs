/**
 * Address classification helpers used to block SSRF targets.
 * Everything here is pure: given an IP string, decide whether it is reachable
 * on the public internet or belongs to a private / reserved range.
 */
import net from 'node:net';

const IPV4_BLOCKED = [
  // [network, maskBits] -> expanded below
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

const IPV4_RANGES = IPV4_BLOCKED.map(([network, bits]) => {
  const base = ipv4ToInt(network);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { start: (base & mask) >>> 0, end: ((base & mask) | (~mask >>> 0)) >>> 0 };
});

export function isBlockedIpv4(ip) {
  const value = ipv4ToInt(ip);
  if (value === null) return true;
  return IPV4_RANGES.some((range) => value >= range.start && value <= range.end);
}

/** Expand any IPv6 textual form into 16 raw bytes, or null when unparsable. */
export function parseIpv6(input) {
  let text = String(input).trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (!text.includes(':')) return null;

  // Rewrite a trailing dotted-quad into two hex groups so the rest of the
  // parser only ever deals with pure hex groups.
  const lastColon = text.lastIndexOf(':');
  const lastPart = text.slice(lastColon + 1);
  if (lastPart.includes('.')) {
    const embedded = ipv4ToInt(lastPart);
    if (embedded === null) return null;
    const hi = ((embedded >>> 16) & 0xffff).toString(16);
    const lo = (embedded & 0xffff).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const doubleColon = text.indexOf('::');
  let headText = text;
  let tailText = '';
  if (doubleColon !== -1) {
    if (text.indexOf('::', doubleColon + 1) !== -1) return null;
    headText = text.slice(0, doubleColon);
    tailText = text.slice(doubleColon + 2);
  }

  const parseGroups = (chunk) => {
    if (chunk === '') return [];
    const groups = chunk.split(':');
    const out = [];
    for (const group of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      const value = parseInt(group, 16);
      out.push((value >> 8) & 0xff, value & 0xff);
    }
    return out;
  };

  const head = parseGroups(headText);
  const body = parseGroups(tailText);
  if (head === null || body === null) return null;

  let bytes;
  if (doubleColon !== -1) {
    const fill = 16 - head.length - body.length;
    if (fill < 0) return null;
    bytes = [...head, ...new Array(fill).fill(0), ...body];
  } else {
    bytes = [...head, ...body];
  }
  if (bytes.length !== 16) return null;
  return bytes;
}

function embeddedIpv4FromBytes(bytes, offset) {
  return `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
}

export function isBlockedIpv6(input) {
  const b = parseIpv6(input);
  if (!b) return true;

  const allZero = b.every((byte) => byte === 0);
  if (allZero) return true; // :: unspecified

  const isMapped = b.slice(0, 10).every((byte) => byte === 0) && b[10] === 0xff && b[11] === 0xff;
  if (isMapped) return isBlockedIpv4(embeddedIpv4FromBytes(b, 12));

  const isCompatible = b.slice(0, 12).every((byte) => byte === 0);
  if (isCompatible) return true; // includes ::1 loopback and v4-compatible

  const isNat64 = b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b;
  if (isNat64) return isBlockedIpv4(embeddedIpv4FromBytes(b, 12));

  if (b[0] === 0x20 && b[1] === 0x02) {
    return isBlockedIpv4(embeddedIpv4FromBytes(b, 2)); // 6to4
  }

  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link local
  if (b[0] === 0xff) return true; // multicast
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // docs
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) {
    // 2001::/32 Teredo tunnels carry an embedded v4 in the last 4 bytes
    return isBlockedIpv4(embeddedIpv4FromBytes(b, 12));
  }

  return (b[0] & 0xe0) !== 0x20; // only global unicast 2000::/3 is allowed
}

export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

/**
 * 主机名是否指向本机 / 内网。
 *
 * 和 `isBlockedAddress` 的区别是它接受**主机名**而不只是 IP：上游把
 * `http://127.0.0.1:4399/files/x.png` 这种「它自己那台机器」的地址原样吐回来时，
 * 我们要能认出来并换掉。普通域名一律返回 false——域名解析到内网由下载器在
 * DNS 之后拦，不在这一层猜。
 */
export function isPrivateHostname(hostname) {
  const host = String(hostname ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const family = net.isIP(host);
  return family ? isBlockedAddress(host) : false;
}
