/* A small, dependency-free router since no package registry access is
   available in this environment to install Express. Supports :params,
   JSON body parsing, and a consistent JSON response helper. Swapping this
   for Express later is a drop-in replacement if/when npm access exists —
   nothing above this layer needs to change. */

function matchRoute(pattern, pathname) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

function createRouter() {
  const routes = [];
  const api = {};
  ['get', 'post', 'patch', 'delete'].forEach(method => {
    api[method] = (pattern, handler) => {
      routes.push({ method: method.toUpperCase(), pattern, handler });
    };
  });

  api.handle = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const query = Object.fromEntries(url.searchParams);

    for (const route of routes) {
      if (route.method !== req.method) continue;
      const params = matchRoute(route.pattern, url.pathname);
      if (!params) continue;

      let body = {};
      if (['POST', 'PATCH'].includes(req.method)) {
        try {
          body = await readJsonBody(req);
        } catch (e) {
          return sendJson(res, 400, { error: 'Invalid JSON body.' });
        }
      }

      try {
        await route.handler({ req, res, params, query, body, sendJson: (code, data) => sendJson(res, code, data) });
      } catch (e) {
        console.error(e);
        sendJson(res, e.statusCode || 500, { error: e.message || 'Internal server error.' });
      }
      return;
    }
    sendJson(res, 404, { error: 'Not found.' });
  };

  return api;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) { // 20MB cap on request body (covers base64 file uploads)
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
  // The frontend is served by this same server, so same-origin requests
  // never need a CORS header at all — browsers only require one for
  // cross-origin calls. Only send one if ALLOWED_ORIGIN is explicitly set
  // (e.g. a separately-hosted frontend calling this API), rather than the
  // wide-open "*" default, which just expands the attack surface for no
  // benefit this app actually needs.
  if (process.env.ALLOWED_ORIGIN) headers['Access-Control-Allow-Origin'] = process.env.ALLOWED_ORIGIN;
  res.writeHead(statusCode, headers);
  res.end(body);
}

class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

module.exports = { createRouter, sendJson, ApiError };
