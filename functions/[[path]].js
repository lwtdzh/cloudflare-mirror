/**
 * Catch-all proxy function for Cloudflare Pages.
 * Matches paths against mirror rules in KV, fetches from the delegated path,
 * and rewrites links in HTML/JS responses to fit the proxy address.
 */

const HTML_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
];

const JS_CONTENT_TYPES = [
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
];

const CSS_CONTENT_TYPES = [
  'text/css',
];

const TEXT_CONTENT_TYPES = [
  'text/html',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'text/css',
  'text/xml',
  'application/xhtml+xml',
  'application/xml',
];

function isTextContentType(ct) {
  if (!ct) return false;
  const lower = ct.toLowerCase().split(';')[0].trim();
  return TEXT_CONTENT_TYPES.includes(lower);
}

function isRewritableContentType(ct) {
  if (!ct) return false;
  const lower = ct.toLowerCase().split(';')[0].trim();
  return HTML_CONTENT_TYPES.includes(lower) || JS_CONTENT_TYPES.includes(lower) || CSS_CONTENT_TYPES.includes(lower);
}

function isHTMLContentType(ct) {
  if (!ct) return false;
  const lower = ct.toLowerCase().split(';')[0].trim();
  return HTML_CONTENT_TYPES.includes(lower);
}

function isJSContentType(ct) {
  if (!ct) return false;
  const lower = ct.toLowerCase().split(';')[0].trim();
  return JS_CONTENT_TYPES.includes(lower);
}

/**
 * Rewrite URLs in text content so that links pointing to the delegated origin
 * are converted to point to the proxy path instead.
 */
function rewriteContent(content, mirrorEntry, requestUrl, contentType) {
  const { originalPath, delegatedUrl } = mirrorEntry;

  // Parse the delegated URL to get its origin
  let delegatedOrigin;
  try {
    const u = new URL(delegatedUrl);
    delegatedOrigin = u.origin; // e.g. "https://x.y"
  } catch (e) {
    return content;
  }

  // Parse the request URL to get our origin
  let proxyOrigin;
  try {
    const u = new URL(requestUrl);
    proxyOrigin = u.origin; // e.g. "https://xx.pages.dev"
  } catch (e) {
    return content;
  }

  // Compute the delegated path portion
  // e.g. delegatedUrl = "http://x.y/abc/def" -> delegatedPathPrefix = "/abc/def"
  let delegatedPathPrefix;
  try {
    const u = new URL(delegatedUrl);
    delegatedPathPrefix = u.pathname;
    // Remove trailing slash for consistent matching
    if (delegatedPathPrefix.endsWith('/') && delegatedPathPrefix !== '/') {
      delegatedPathPrefix = delegatedPathPrefix.slice(0, -1);
    }
  } catch (e) {
    return content;
  }

  // The proxy path prefix (always starts with /)
  // e.g. originalPath = "def2" -> proxyPathPrefix = "/def2"
  const proxyPathPrefix = '/' + originalPath.replace(/^\/+/, '');

  const isHtml = isHTMLContentType(contentType);
  const isJs = isJSContentType(contentType);

  // We need to rewrite:
  // 1. Full URLs: delegatedOrigin + delegatedPathPrefix + ... -> proxyOrigin + proxyPathPrefix + ...
  // 2. Absolute paths starting with delegatedPathPrefix: /abc/def/... -> /def2/...
  // 3. Relative paths that resolve to delegated origin (less common, but possible)

  // Strategy: replace all occurrences of delegatedOrigin + delegatedPathPrefix and standalone delegatedPathPrefix

  let result = content;

  // Replace full URLs first: "https://x.y/abc/def" -> "https://xx.pages.dev/def2"
  // Handle both http and https versions of the delegated URL
  const delegatedUrlNoProtocol = delegatedOrigin.replace(/^https?:\/\//, '') + delegatedPathPrefix;
  const httpDelegatedOrigin = 'http://' + delegatedOrigin.replace(/^https?:\/\//, '');
  const httpsDelegatedOrigin = 'https://' + delegatedOrigin.replace(/^https?:\/\//, '');

  // Replace full URLs with protocol
  // e.g. "https://x.y/abc/def" -> "https://xx.pages.dev/def2"
  // e.g. "http://x.y/abc/def" -> "https://xx.pages.dev/def2" (always use https for pages.dev)
  result = result.replace(
    new RegExp(escapeRegex(httpsDelegatedOrigin + delegatedPathPrefix), 'g'),
    proxyOrigin + proxyPathPrefix
  );
  result = result.replace(
    new RegExp(escapeRegex(httpDelegatedOrigin + delegatedPathPrefix), 'g'),
    proxyOrigin + proxyPathPrefix
  );

  // Replace protocol-relative URLs: "//x.y/abc/def" -> "//xx.pages.dev/def2"
  result = result.replace(
    new RegExp(escapeRegex('//' + delegatedOrigin.replace(/^https?:\/\//, '') + delegatedPathPrefix), 'g'),
    '//' + proxyOrigin.replace(/^https?:\/\//, '') + proxyPathPrefix
  );

  // Replace absolute paths: "/abc/def" -> "/def2"
  // Only if delegatedPathPrefix is not just "/" (i.e. there's a real path prefix)
  if (delegatedPathPrefix !== '') {
    result = result.replace(
      new RegExp(escapeRegex(delegatedPathPrefix), 'g'),
      proxyPathPrefix
    );
  }

  // For HTML, also handle srcset attributes which have special spacing
  if (isHtml) {
    // srcset patterns like "/abc/def/image.jpg 300w, /abc/def/image-large.jpg 600w"
    // The above replacements should already handle these since we replaced the path prefix
  }

  return result;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find which mirror entry matches the given request path.
 * Returns the mirror entry and the remaining subpath.
 */
async function findMirror(pathname, kv) {
  const list = await kv.get('mirror_list', { type: 'json' });
  if (!list || !Array.isArray(list)) return null;

  // Try longest path first for more specific matches
  // Sort by originalPath length descending
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

  // Skip admin and API paths
  if (pathname === '/admin' || pathname === '/admin/' || pathname.startsWith('/admin/') ||
      pathname.startsWith('/api/')) {
    return context.next();
  }

  const result = await findMirror(pathname, env.MIRRORS_KV);
  if (!result) {
    // No mirror match, pass through to static files
    return context.next();
  }

  const { entry, subpath } = result;
  let targetUrl;

  try {
    const delegated = new URL(entry.delegatedUrl);
    // Append subpath to delegated URL
    const basePath = delegated.pathname.replace(/\/+$/, '');
    targetUrl = delegated.origin + basePath + subpath;
    // Preserve query string
    if (url.search) {
      targetUrl += url.search;
    }
  } catch (e) {
    return new Response('Invalid delegated URL', { status: 500 });
  }

  // Fetch from target
  try {
    const headers = new Headers(request.headers);
    // Set the host header to match the target
    const targetParsed = new URL(targetUrl);
    headers.set('Host', targetParsed.host);
    headers.set('Referer', targetParsed.origin + targetParsed.pathname);
    // Remove cloudflare-specific headers that might cause issues
    headers.delete('cf-connecting-ip');
    headers.delete('cf-ipcountry');
    headers.delete('cf-ray');
    headers.delete('cf-visitor');

    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      redirect: 'follow',
    });

    const contentType = response.headers.get('Content-Type') || '';

    // If rewritable content type, rewrite URLs
    if (isRewritableContentType(contentType)) {
      let body = await response.text();
      body = rewriteContent(body, entry, request.url, contentType);

      const newHeaders = new Headers(response.headers);
      // Remove content-length since we modified the body
      newHeaders.delete('Content-Length');
      // Ensure correct encoding
      newHeaders.set('Content-Type', contentType);

      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    // For non-text content (images, binaries, etc.), pass through unchanged
    // Clone response to avoid body-use issues
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

  } catch (e) {
    return new Response(`Proxy error: ${e.message}`, { status: 502 });
  }
}