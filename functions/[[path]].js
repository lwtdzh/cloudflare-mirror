/**
 * Catch-all proxy function for Cloudflare Pages.
 * Matches paths against mirror rules in KV, fetches from the delegated path,
 * and rewrites links in HTML/JS/CSS responses to fit the proxy address.
 * Handles redirects by rewriting Location headers (like curl -L, but visible to browser).
 */

const HTML_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];
const JS_CONTENT_TYPES = ['text/javascript', 'application/javascript', 'application/x-javascript'];
const CSS_CONTENT_TYPES = ['text/css'];
const REWRITABLE_TYPES = [...HTML_CONTENT_TYPES, ...JS_CONTENT_TYPES, ...CSS_CONTENT_TYPES];
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

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
 * Rewrite a URL: if it points to the delegated origin/path, convert it to the proxy path.
 * Handles full URLs, absolute paths, and relative paths.
 * Returns the rewritten URL string.
 */
function rewriteUrl(rawUrl, mirrorEntry, requestUrl) {
  const { originalPath, delegatedPath } = mirrorEntry;

  let delegatedParsed;
  try {
    delegatedParsed = new URL(delegatedPath);
  } catch (e) {
    return rawUrl;
  }

  const delegatedOrigin = delegatedParsed.origin;
  let delegatedPathPrefix = delegatedParsed.pathname;
  if (delegatedPathPrefix.endsWith('/') && delegatedPathPrefix !== '/') {
    delegatedPathPrefix = delegatedPathPrefix.slice(0, -1);
  }

  let proxyOrigin;
  try {
    proxyOrigin = new URL(requestUrl).origin;
  } catch (e) {
    return rawUrl;
  }

  const proxyPathPrefix = '/' + originalPath.replace(/^\/+/, '');

  // Try to parse the raw URL
  try {
    const parsed = new URL(rawUrl, requestUrl);

    // Case 1: Full URL pointing to delegated origin
    if (parsed.origin === delegatedOrigin) {
      // Check if path starts with delegated path prefix
      if (parsed.pathname.startsWith(delegatedPathPrefix + '/') || parsed.pathname === delegatedPathPrefix) {
        const remainingPath = parsed.pathname.slice(delegatedPathPrefix.length);
        const newUrl = proxyOrigin + proxyPathPrefix + remainingPath + parsed.search + parsed.hash;
        return newUrl;
      }
      // Path is on delegated origin but not under the delegated path prefix
      // Don't rewrite - it's some other path on the same origin
      return rawUrl;
    }

    // Case 2: Same-origin absolute path (protocol-relative or just path)
    // If the rawUrl is on our proxy origin, check if it should stay as-is
    if (parsed.origin === proxyOrigin) {
      return rawUrl;
    }

    // Different origin entirely - no rewriting needed
    return rawUrl;
  } catch (e) {
    // rawUrl might be a relative path that can't be parsed as a full URL
    // Handle absolute paths starting with delegatedPathPrefix
    if (rawUrl.startsWith(delegatedPathPrefix + '/') || rawUrl === delegatedPathPrefix) {
      const remaining = rawUrl.slice(delegatedPathPrefix.length);
      return proxyPathPrefix + remaining;
    }
    return rawUrl;
  }
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
    result = result.replace(
      new RegExp(escapeRegex(delegatedPathPrefix) + '(?=[/\\s"\'<>:,;?!&=()\\[\\]{}]|$)', 'g'),
      proxyPathPrefix
    );
  }

  return result;
}

const MIRROR_KEY_PREFIX = 'mirror::';

/**
 * Find which mirror entry matches the given request path.
 * Each mirror is stored as a separate KV entry: "mirror::{originalPath}" → "delegatedPath".
 * Returns the mirror entry and the remaining subpath.
 */
async function findMirror(pathname, kv) {
  const cleanPathname = pathname.replace(/^\/+/, '');
  if (!cleanPathname) return null;

  // Try progressively shorter path prefixes for longest-match-first behavior.
  // e.g. for "a/b/c/d", try "a/b/c/d", then "a/b/c", then "a/b", then "a".
  const segments = cleanPathname.split('/');
  for (let length = segments.length; length > 0; length--) {
    const candidate = segments.slice(0, length).join('/');
    const delegatedPath = await kv.get(MIRROR_KEY_PREFIX + candidate);
    if (delegatedPath !== null) {
      const subpath = cleanPathname.slice(candidate.length);
      return {
        entry: { originalPath: candidate, delegatedPath },
        subpath,
      };
    }
  }

  return null;
}

/**
 * Rewrite a Location header value from a redirect response.
 * If the redirect points to the delegated origin, rewrite it to point to the proxy.
 */
function rewriteLocationHeader(location, mirrorEntry, requestUrl) {
  if (!location) return location;
  return rewriteUrl(location, mirrorEntry, requestUrl);
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

  // Fetch from target - we handle redirects ourselves (like curl -L)
  // but we rewrite Location headers so the browser sees proxy URLs
  const MAX_REDIRECTS = 10;
  let currentUrl = targetUrl;
  let method = request.method;
  let body = request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined;
  let response;

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
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

    const currentParsed = new URL(currentUrl);
    fetchHeaders.set('Host', currentParsed.host);
    fetchHeaders.set('Referer', currentParsed.origin + currentParsed.pathname);

    // Mark as subrequest to prevent infinite loops
    fetchHeaders.set('X-Mirror-Subrequest', 'true');

    response = await fetch(currentUrl, {
      method,
      headers: fetchHeaders,
      body,
      redirect: 'manual', // We handle redirects ourselves
    });

    // If it's a redirect, rewrite the Location and follow it (like curl -L)
    if (REDIRECT_STATUSES.includes(response.status)) {
      const location = response.headers.get('Location');
      if (!location) break; // No Location header, stop following

      // Rewrite the Location header if it points to the delegated origin
      const rewrittenLocation = rewriteLocationHeader(location, entry, request.url);

      // Resolve the rewritten location against the current URL for the next fetch
      // We follow the ORIGINAL location for fetching (not the rewritten one),
      // because the next fetch must go to the real target
      const nextFetchUrl = new URL(location, currentUrl).toString();

      // For 301/302/303, change method to GET and drop body (like curl -L)
      if (response.status === 301 || response.status === 302 || response.status === 303) {
        method = 'GET';
        body = undefined;
      }

      currentUrl = nextFetchUrl;
      continue; // Follow the redirect
    }

    // Not a redirect - we have our final response
    break;
  }

  // Handle case where we followed all redirects and the final response is itself a redirect
  if (REDIRECT_STATUSES.includes(response.status)) {
    const location = response.headers.get('Location');
    const rewrittenLocation = rewriteLocationHeader(location, entry, request.url);
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Location', rewrittenLocation);
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  }

  const contentType = response.headers.get('Content-Type') || '';

  // If rewritable content type, rewrite URLs in the response
  if (isRewritableContentType(contentType)) {
    let responseBody = await response.text();
    responseBody = rewriteContent(responseBody, entry, request.url, contentType);

    const newHeaders = new Headers(response.headers);
    newHeaders.delete('Content-Length');
    newHeaders.delete('Content-Encoding');
    newHeaders.set('Content-Type', contentType);

    return new Response(responseBody, {
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
}