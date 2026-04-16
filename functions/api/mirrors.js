const MIRROR_KEY_PREFIX = 'mirror::';
const MIRROR_INDEX_KEY = 'mirror_index';

/**
 * Verify the admin password from the request against the environment variable.
 * Password is set via Cloudflare Pages environment variables (ADMIN_PASSWORD),
 * so it never appears in source code or KV.
 */
function verifyPassword(request, env, corsHeaders) {
  const authHeader = request.headers.get('X-Admin-Password') || '';
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Password required' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const storedPassword = env.ADMIN_PASSWORD;
  if (!storedPassword || authHeader !== storedPassword) {
    return new Response(JSON.stringify({ error: 'Invalid password' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  return null; // password is valid
}

/**
 * Get the mirror index — a list of all originalPaths stored in KV.
 * This is immediately consistent (unlike kv.list() which is eventually consistent).
 */
async function getMirrorIndex(kv) {
  return await kv.get(MIRROR_INDEX_KEY, { type: 'json' }) || [];
}

/**
 * List all mirrors by reading the index and then fetching each entry individually.
 * Each mirror's delegatedPath is stored as: "mirror::{originalPath}" → "{delegatedPath}"
 * The index stores just the list of originalPaths for immediate consistency.
 */
async function listAllMirrors(kv) {
  const index = await getMirrorIndex(kv);
  const mirrors = [];
  for (const originalPath of index) {
    const delegatedPath = await kv.get(MIRROR_KEY_PREFIX + originalPath);
    if (delegatedPath !== null) {
      mirrors.push({ originalPath, delegatedPath });
    }
  }
  return mirrors;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // GET /api/mirrors - list all mirrors (public)
    // If "verify" query param is present, also verify the admin password (used by admin login)
    if (request.method === 'GET') {
      if (url.searchParams.has('verify')) {
        const authError = verifyPassword(request, env, corsHeaders);
        if (authError) return authError;
      }

      const list = await listAllMirrors(env.MIRRORS_KV);
      return new Response(JSON.stringify(list), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // POST /api/mirrors - add a new mirror
    if (request.method === 'POST') {
      const authError = verifyPassword(request, env, corsHeaders);
      if (authError) return authError;

      const body = await request.json();
      if (!body.originalPath || !body.delegatedPath) {
        return new Response(JSON.stringify({ error: 'originalPath and delegatedPath are required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const originalPath = body.originalPath.replace(/^\/+|\/+$/g, '');
      const delegatedPath = body.delegatedPath.replace(/\/+$/, '');
      if (!originalPath) {
        return new Response(JSON.stringify({ error: 'originalPath cannot be empty' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      // Check for duplicate originalPath
      const existing = await env.MIRRORS_KV.get(MIRROR_KEY_PREFIX + originalPath);
      if (existing !== null) {
        return new Response(JSON.stringify({ error: 'A mirror with originalPath "' + originalPath + '" already exists' }), {
          status: 409,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      // Write the mirror entry and update the index
      await env.MIRRORS_KV.put(MIRROR_KEY_PREFIX + originalPath, delegatedPath);
      const index = await getMirrorIndex(env.MIRRORS_KV);
      index.push(originalPath);
      await env.MIRRORS_KV.put(MIRROR_INDEX_KEY, JSON.stringify(index));
      const mirror = { originalPath, delegatedPath };
      return new Response(JSON.stringify(mirror), {
        status: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // PUT /api/mirrors - update a mirror
    if (request.method === 'PUT') {
      const authError = verifyPassword(request, env, corsHeaders);
      if (authError) return authError;

      const body = await request.json();
      if (!body.oldOriginalPath || !body.originalPath || !body.delegatedPath) {
        return new Response(JSON.stringify({ error: 'oldOriginalPath, originalPath and delegatedPath are required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const oldKey = MIRROR_KEY_PREFIX + body.oldOriginalPath;
      const oldValue = await env.MIRRORS_KV.get(oldKey);
      if (oldValue === null) {
        return new Response(JSON.stringify({ error: 'Mirror not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const newOriginalPath = body.originalPath.replace(/^\/+|\/+$/g, '');
      const newDelegatedPath = body.delegatedPath.replace(/\/+$/, '');
      // Check for duplicate originalPath when the path is being changed
      if (newOriginalPath !== body.oldOriginalPath) {
        const duplicateCheck = await env.MIRRORS_KV.get(MIRROR_KEY_PREFIX + newOriginalPath);
        if (duplicateCheck !== null) {
          return new Response(JSON.stringify({ error: 'A mirror with originalPath "' + newOriginalPath + '" already exists' }), {
            status: 409,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        // Delete old key and update index
        await env.MIRRORS_KV.delete(oldKey);
        const index = await getMirrorIndex(env.MIRRORS_KV);
        const updatedIndex = index.filter(p => p !== body.oldOriginalPath);
        updatedIndex.push(newOriginalPath);
        await env.MIRRORS_KV.put(MIRROR_INDEX_KEY, JSON.stringify(updatedIndex));
      }
      await env.MIRRORS_KV.put(MIRROR_KEY_PREFIX + newOriginalPath, newDelegatedPath);
      return new Response(JSON.stringify({ originalPath: newOriginalPath, delegatedPath: newDelegatedPath }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // DELETE /api/mirrors?originalPath=xxx - delete a mirror
    if (request.method === 'DELETE') {
      const authError = verifyPassword(request, env, corsHeaders);
      if (authError) return authError;

      const originalPath = url.searchParams.get('originalPath');
      if (!originalPath) {
        return new Response(JSON.stringify({ error: 'originalPath parameter is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const key = MIRROR_KEY_PREFIX + originalPath;
      const existing = await env.MIRRORS_KV.get(key);
      if (existing === null) {
        return new Response(JSON.stringify({ error: 'Mirror not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await env.MIRRORS_KV.delete(key);
      // Update the index
      const index = await getMirrorIndex(env.MIRRORS_KV);
      const updatedIndex = index.filter(p => p !== originalPath);
      await env.MIRRORS_KV.put(MIRROR_INDEX_KEY, JSON.stringify(updatedIndex));
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}