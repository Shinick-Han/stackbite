'use strict';
const https = require('node:https');
const { createWriteStream } = require('node:fs');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { LIMITS, fail, hashFile } = require('./common');

function secureURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) {
    fail('Release redirect is not an approved HTTPS origin');
  }
  return url;
}
async function download(spec, destination, { request = https.get, timeout = LIMITS.timeout } = {}) {
  if (!Number.isSafeInteger(spec.size) || spec.size <= 0 || spec.size > LIMITS.download) fail('Invalid pinned download size');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let current = secureURL(spec.url);
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await new Promise((resolve, reject) => {
        const req = request(current, { signal: controller.signal, headers: {
          'User-Agent': 'Stackbite-npm-bootstrap', 'Accept-Encoding': 'identity', Accept: 'application/octet-stream'
        } }, resolve);
        req.once('error', () => reject(new Error('Release download failed or timed out')));
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        response.destroy();
        if (redirects === 5 || typeof location !== 'string' || location.length > 4096) fail('Invalid release redirect');
        current = secureURL(new URL(location, current).href);
        continue;
      }
      if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
        response.destroy(); fail('Release download was not available');
      }
      const length = response.headers['content-length'];
      if (length !== undefined && String(spec.size) !== length) { response.destroy(); fail('Release download size mismatch'); }
      let size = 0;
      const bounded = new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length;
        callback(size > spec.size ? new Error('Release download exceeds pinned size') : null, chunk);
      } });
      await pipeline(response, bounded, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
      if (size !== spec.size || await hashFile(destination, LIMITS.download) !== spec.sha256) fail('Release SHA-256 or size mismatch');
      return;
    }
  } finally { clearTimeout(timer); }
}
module.exports = { download, secureURL };
