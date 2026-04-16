const MIRROR_KEY_PREFIX = 'mirror::';

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
 * List all mirrors from KV. Each mirror is stored as a separate KV entry:
 *   key: "mirror::{originalPath}"  →  value: "{delegatedPath}"
 */
async function listAllMirrors(kv) {
  const mirrors = [];
  let cursor = undefined;
  do {
    const result = await kv.list({ prefix: MIRROR_KEY_PREFIX, cursor });
    for (const key of result.keys) {
      const originalPath = key.name.slice(MIRROR_KEY_PREFIX.length);
      const delegatedPath = await kv.get(key.name);
      if (delegatedPath !== null) {
        mirrors.push({ originalPath, delegatedPath });
      }
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
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
    // GET /api/mirrors - list all mirrors (requires password)
    if (request.method === 'GET') {
      const authError = verifyPassword(request, env, corsHeaders);
      if (authError) return authError;

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
      await env.MIRRORS_KV.put(MIRROR_KEY_PREFIX + originalPath, delegatedPath);
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
        // Delete old key, write new key
        await env.MIRRORS_KV.delete(oldKey);
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