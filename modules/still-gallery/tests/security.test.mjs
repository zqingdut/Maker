import test from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedAddress, isBlockedIpv4, isBlockedIpv6, parseIpv6 } from '../lib/address-guard.mjs';
import { downloadImage, parseImageUrl, sniffImage, DownloadError } from '../lib/downloader.mjs';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

test('private and reserved IPv4 ranges are blocked', () => {
  const blocked = [
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.254', '100.64.1.1', '127.0.0.1', '127.9.9.9',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.8', '192.0.2.5', '192.88.99.1',
    '192.168.1.1', '198.18.0.1', '198.51.100.9', '203.0.113.4', '224.0.0.1', '240.0.0.1',
    '255.255.255.255',
  ];
  for (const ip of blocked) assert.equal(isBlockedIpv4(ip), true, `${ip} should be blocked`);
});

test('public IPv4 addresses are allowed', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '11.0.0.1']) {
    assert.equal(isBlockedIpv4(ip), false, `${ip} should be allowed`);
  }
});

test('ipv6 parsing handles compressed, mapped and 6to4 forms', () => {
  assert.deepEqual(parseIpv6('::1'), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(parseIpv6('2606:4700::1111').length, 16);
  assert.equal(parseIpv6('not-an-ip'), null);
});

test('ipv6 loopback, link local, unique local and v4-mapped private ranges are blocked', () => {
  const blocked = [
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:192.168.0.1', '64:ff9b::7f00:1',
    '2002:7f00:0001::1', '2002:0a00:0001::1',
  ];
  for (const ip of blocked) assert.equal(isBlockedIpv6(ip), true, `${ip} should be blocked`);
});

test('global unicast ipv6 addresses are allowed', () => {
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:1.1.1.1']) {
    assert.equal(isBlockedIpv6(ip), false, `${ip} should be allowed`);
  }
});

test('isBlockedAddress rejects unparsable input', () => {
  assert.equal(isBlockedAddress('example.com'), true);
  assert.equal(isBlockedAddress('1.2.3'), true);
  assert.equal(isBlockedAddress('1.2.3.4'), false);
});

test('parseImageUrl only accepts plain http(s) urls on common ports', () => {
  assert.equal(parseImageUrl('https://cdn.example.com/a.png').host, 'cdn.example.com');
  assert.equal(parseImageUrl('http://cdn.example.com:8080/a.png').url.port, '8080');

  const rejected = [
    'file:///etc/passwd',
    'ftp://cdn.example.com/a.png',
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'https://user:pass@cdn.example.com/a.png',
    'https://cdn.example.com:22/a.png',
    'not a url',
  ];
  for (const raw of rejected) {
    assert.throws(() => parseImageUrl(raw), DownloadError, `${raw} should be rejected`);
  }
});

test('sniffImage accepts real bitmaps and rejects everything else', () => {
  assert.equal(sniffImage(PNG).ext, '.png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])).ext, '.jpg');
  assert.equal(sniffImage(Buffer.from('GIF89a....', 'latin1')).ext, '.gif');
  assert.equal(sniffImage(Buffer.from('RIFF....WEBPVP8 ', 'latin1')).ext, '.webp');
  assert.equal(sniffImage(Buffer.from('....ftypavif', 'latin1')).ext, '.avif');

  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniffImage(Buffer.from('<!DOCTYPE html><html></html>')), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test('downloadImage refuses to connect when DNS resolves to a private address', async () => {
  let fetched = false;
  await assert.rejects(
    downloadImage('https://evil.example.com/a.png', {
      resolveImpl: async () => ({ address: '127.0.0.1', family: 4 }),
      fetchImpl: async () => {
        fetched = true;
        return { status: 200, headers: {}, body: PNG };
      },
    }),
    /内网或保留地址/,
  );
  assert.equal(fetched, false, 'the request must never reach the network');
});

test('downloadImage rejects a redirect that lands on a private address', async () => {
  const calls = [];
  await assert.rejects(
    downloadImage('https://cdn.example.com/a.png', {
      resolveImpl: async (host) => {
        calls.push(host);
        return host === 'cdn.example.com'
          ? { address: '93.184.216.34', family: 4 }
          : { address: '169.254.169.254', family: 4 };
      },
      fetchImpl: async () => ({
        status: 302,
        headers: { location: 'https://metadata.internal/latest/meta-data/' },
        body: Buffer.alloc(0),
      }),
    }),
    /内网或保留地址/,
  );
  assert.deepEqual(calls, ['cdn.example.com', 'metadata.internal']);
});

test('downloadImage rejects non-image payloads and oversized bodies', async () => {
  await assert.rejects(
    downloadImage('https://cdn.example.com/page', {
      resolveImpl: async () => ({ address: '93.184.216.34', family: 4 }),
      fetchImpl: async () => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: Buffer.from('<html>nope</html>'),
      }),
    }),
    /位图图片/,
  );

  await assert.rejects(
    downloadImage('https://cdn.example.com/fake.png', {
      resolveImpl: async () => ({ address: '93.184.216.34', family: 4 }),
      fetchImpl: async () => ({
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(64, 1)]),
      }),
    }),
    /无法识别的图片格式/,
  );

  await assert.rejects(
    downloadImage('https://cdn.example.com/huge.png', {
      resolveImpl: async () => ({ address: '93.184.216.34', family: 4 }),
      fetchImpl: async () => ({
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: Buffer.concat([PNG, Buffer.alloc(16 * 1024 * 1024)]),
      }),
    }),
    /15MB/,
  );
});

test('downloadImage returns the sniffed format for a valid payload', async () => {
  const result = await downloadImage('https://cdn.example.com/a.png', {
    resolveImpl: async () => ({ address: '93.184.216.34', family: 4 }),
    fetchImpl: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: PNG }),
  });
  assert.equal(result.ext, '.png');
  assert.equal(result.mime, 'image/png');
  assert.equal(result.sourceUrl, 'https://cdn.example.com/a.png');
  assert.equal(result.bytes, PNG.length);
});

/* ------------------------------------------------------------------ *
 * 操作者自己配置的网关：只按「回了话的那个源站」放行
 * ------------------------------------------------------------------ */

test('a gateway URL on a non-standard port is refused unless its origin is trusted', async () => {
  const raw = 'http://127.0.0.1:4402/files/abc.png';

  // 外来的地址：端口不在白名单，连 DNS 都不该查。
  assert.throws(() => parseImageUrl(raw), /不被允许的端口/);

  let resolved = 0;
  await assert.rejects(
    downloadImage(raw, {
      resolveImpl: async () => {
        resolved += 1;
        return { address: '127.0.0.1', family: 4 };
      },
      fetchImpl: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: PNG }),
    }),
    /不被允许的端口/,
  );
  assert.equal(resolved, 0, '校验必须在解析之前就拦住');

  // 同一个地址，只有当它是配置里那个网关的源站时才放行。
  const result = await downloadImage(raw, {
    trustedOrigins: ['http://127.0.0.1:4402'],
    fetchImpl: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: PNG }),
  });
  assert.equal(result.ext, '.png');
  assert.equal(result.sourceUrl, raw);
});

test('a trusted origin does not extend to wherever it redirects', async () => {
  const seen = [];
  await assert.rejects(
    downloadImage('http://127.0.0.1:4402/files/abc.png', {
      trustedOrigins: ['http://127.0.0.1:4402'],
      resolveImpl: async (host) => {
        seen.push(host);
        return { address: '169.254.169.254', family: 4 };
      },
      fetchImpl: async () => ({
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        body: Buffer.alloc(0),
      }),
    }),
    /内网或保留地址/,
  );
  assert.deepEqual(seen, ['169.254.169.254'], '重定向目标不在白名单，要按普通地址校验');
});

test('the trusted-origin list accepts a Set and ignores malformed entries', async () => {
  const result = await downloadImage('http://127.0.0.1:4402/files/abc.png', {
    trustedOrigins: new Set(['not a url', 'http://127.0.0.1:4402']),
    fetchImpl: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, body: PNG }),
  });
  assert.equal(result.ext, '.png');
});
