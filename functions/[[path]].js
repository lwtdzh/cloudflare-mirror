/**
 * Catch-all proxy function for Cloudflare Pages.
 * Matches paths against mirror rules in KV, fetches from the delegated path,
 * and rewrites links in HTML/JS/CSS responses to fit the proxy address.
 */

const HTML_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];
const JS_CONTENT_TYPES = ['text/javascript', 'application/javascript', 'application/x-javascript'];
const CSS_CONTENT_TYPES = ['text/css'];
const REWRITABLE_TYPES = [...HTML_CONTENT_TYPES, ...JS_CONTENT_TYPES, ...CSS_CONTENT_TYPES];

function isRewritableContentType(ct) {
  if (!ct) return false;
  const lower = ct.toLowerCase().split(';')[0].trim();
  return REWRITABLE_TYPES.includes(lower);
}

function isHTMLContentType(ct) {
  if (!ct) return false;
  const lower = ct.toLowerCase().split(';')[0].trim();
  return HTML_CONTENT_TYPES.includes(lower);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rewrite URLs in text content so that links pointing to the delegated origin
 * are converted to point to the proxy path instead.
 */
function rewriteContent(content, mirrorEntry, requestUrl, contentType) {
  const { originalPath, delegatedPath } = mirrorEntry;

  // Parse the delegated URL
  let delegatedParsed;
  try {
    delegatedParsed = new URL(delegatedPath);
  } catch (e) {
    // delegatedPath might be just a path without origin, e.g. "/abc/def"
    // In that case, we can't rewrite full URLs but can still rewrite paths
    return content;
  }

  const delegatedOrigin = delegatedParsed.origin;
  let delegatedPathPrefix = delegatedParsed.pathname;
  if (delegatedPathPrefix.endsWith('/') && delegatedPathPrefix !== '/') {
    delegatedPathPrefix = delegatedPathPrefix.slice(0, -1);
  }

  // Parse the request URL to get our origin
  let proxyOrigin;
  try {
    proxyOrigin = new URL(requestUrl).origin;
  } catch (e) {
    return content;
  }

  const proxyPathPrefix = '/' + originalPath.replace(/^\/+/, '');

  let result = content;

  // 1. Replace full URLs with both http and https variants of the delegated origin
  const domainPart = delegatedOrigin.replace(/^https?:\/\//, '');
  const httpOrigin = 'http://' + domainPart;
  const httpsOrigin = 'https://' + domainPart;

  result = result.replace(
    new RegExp(escapeRegex(httpsOrigin + delegatedPathPrefix), 'g'),
    proxyOrigin + proxyPathPrefix
  );
  result = result.replace(
    new RegExp(escapeRegex(httpOrigin + delegatedPathPrefix), 'g'),
    proxyOrigin + proxyPathPrefix
  );

  // 2. Replace protocol-relative URLs: "//domain/path" -> "//proxydomain/proxypath"
  result = result.replace(
    new RegExp(escapeRegex('//' + domainPart + delegatedPathPrefix), 'g'),
    '//' + proxyOrigin.replace(/^https?:\/\//, '') + proxyPathPrefix
  );

  // 3. Replace absolute paths: "/abc/def" -> "/def2"
  // Only if there's a non-trivial path prefix (not just "/")
  if (delegatedPathPrefix !== '' && delegatedPathPrefix !== '/') {
    // Use word-boundary-like matching to avoid false replacements in unrelated paths
    // e.g. replace "/source" but not "/resource" (when source is a prefix)
    result = result.replace(
      new RegExp(escapeRegex(delegatedPathPrefix) + '(?=[/\\s"\'<>:,;?!&=()\\[\\]{}]|$)', 'g'),
      proxyPathPrefix
    );
  }

  return result;
}

/**
 * Find which mirror entry matches the given request path.
 * Returns the mirror entry and the remaining subpath.
 */
async function findMirror(pathname, kv) {
  const list = await kv.get('mirror_list', { type: 'json' });
  if (!list || !Array.isArray(list)) return null;

  // Try longest path first for more specific matches
  const sorted = [...list].sort((a, b) => b.originalPath.length - a.originalPath.length);

  for (const entry of sorted) {
    const cleanOriginal = entry.originalPath.replace(/^\/+/, '').replace(/\/+$/, '');
    const cleanPathname = pathname.replace(/^\/+/, '');

    if (cleanPathname === cleanOriginal || cleanPathname.startsWith(cleanOriginal + '/')) {
      const subpath = cleanPathname.slice(cleanOriginal.length);
      return { entry, subpath };
    }
  }

  return null;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Skip admin and API paths - let Pages handle them
  if (pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/admin/') ||
      pathname.startsWith('/api/')) {
    return context.next();
  }

  // If this is a subrequest from our own proxy, skip mirroring to prevent infinite loops
  // This handles the case where a mirror's delegatedPath points to our own Pages domain
  if (request.headers.get('X-Mirror-Subrequest') === 'true') {
    return context.next();
  }

  const result = await findMirror(pathname, env.MIRRORS_KV);
  if (!result) {
    // No mirror match, pass through to static files
    return context.next();
  }

  const { entry, subpath } = result;

  // Build target URL from delegatedPath
  let targetUrl;
  try {
    const delegated = new URL(entry.delegatedPath);
    const basePath = delegated.pathname.replace(/\/+$/, '');
    targetUrl = delegated.origin + basePath + subpath;
    if (url.search) {
      targetUrl += url.search;
    }
  } catch (e) {
    return new Response('Invalid delegated URL: ' + e.message, { status: 500 });
  }

  // Fetch from target
  try {
    const fetchHeaders = new Headers();

    // Forward some client headers
    const accept = request.headers.get('Accept');
    const acceptLang = request.headers.get('Accept-Language');
    const acceptEnc = request.headers.get('Accept-Encoding');
    const userAgent = request.headers.get('User-Agent');
    if (accept) fetchHeaders.set('Accept', accept);
    if (acceptLang) fetchHeaders.set('Accept-Language', acceptLang);
    if (acceptEnc) fetchHeaders.set('Accept-Encoding', acceptEnc);
    if (userAgent) fetchHeaders.set('User-Agent', userAgent);

    // Set appropriate headers for the target
    const targetParsed = new URL(targetUrl);
    fetchHeaders.set('Host', targetParsed.host);
    fetchHeaders.set('Referer', targetParsed.origin + targetParsed.pathname);

    // Mark as subrequest to prevent infinite loops when proxying to our own domain
    fetchHeaders.set('X-Mirror-Subrequest', 'true');

    const response = await fetch(targetUrl, {
      method: request.method,
      headers: fetchHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      redirect: 'follow',
    });

    const contentType = response.headers.get('Content-Type') || '';

    // If rewritable content type, rewrite URLs in the response
    if (isRewritableContentType(contentType)) {
      let body = await response.text();
      body = rewriteContent(body, entry, request.url, contentType);

      const newHeaders = new Headers(response.headers);
      newHeaders.delete('Content-Length');
      newHeaders.delete('Content-Encoding');
      newHeaders.set('Content-Type', contentType);

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    // For non-text content (images, binaries, etc.), pass through unchanged
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

  } catch (e) {
    return new Response(`Proxy error: ${e.message}`, { status: 502 });
  }
}