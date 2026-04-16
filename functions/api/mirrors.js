/**
 * Verify the admin password from the request against the one stored in KV.
 * Password is stored in KV under key "admin_password" — set it via
 * Cloudflare dashboard or `wrangler kv:key put --binding MIRRORS_KV "admin_password" "your-password"`.
 */
async function verifyPassword(request, env, corsHeaders) {
  const authHeader = request.headers.get('X-Admin-Password') || '';
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Password required' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const storedPassword = await env.MIRRORS_KV.get('admin_password');
  if (!storedPassword || authHeader !== storedPassword) {
    return new Response(JSON.stringify({ error: 'Invalid password' }), {
      status: 403,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  return null; // password is valid
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
      const authError = await verifyPassword(request, env, corsHeaders);
      if (authError) return authError;

      const list = await env.MIRRORS_KV.get('mirror_list', { type: 'json' }) || [];
      return new Response(JSON.stringify(list), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // POST /api/mirrors - add a new mirror
    if (request.method === 'POST') {
      const authError = await verifyPassword(request, env, corsHeaders);
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
      const list = await env.MIRRORS_KV.get('mirror_list', { type: 'json' }) || [];
      // Check for duplicate originalPath
      if (list.some(m => m.originalPath === originalPath)) {
        return new Response(JSON.stringify({ error: 'A mirror with originalPath "' + originalPath + '" already exists' }), {
          status: 409,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const mirror = { originalPath, delegatedPath };
      list.push(mirror);
      await env.MIRRORS_KV.put('mirror_list', JSON.stringify(list));
      return new Response(JSON.stringify(mirror), {
        status: 201,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // PUT /api/mirrors - update a mirror
    if (request.method === 'PUT') {
      const authError = await verifyPassword(request, env, corsHeaders);
      if (authError) return authError;

      const body = await request.json();
      if (!body.oldOriginalPath || !body.originalPath || !body.delegatedPath) {
        return new Response(JSON.stringify({ error: 'oldOriginalPath, originalPath and delegatedPath are required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const list = await env.MIRRORS_KV.get('mirror_list', { type: 'json' }) || [];
      const index = list.findIndex(m => m.originalPath === body.oldOriginalPath);
      if (index === -1) {
        return new Response(JSON.stringify({ error: 'Mirror not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const newOriginalPath = body.originalPath.replace(/^\/+|\/+$/g, '');
      // Check for duplicate originalPath when the path is being changed
      if (newOriginalPath !== body.oldOriginalPath) {
        if (list.some(m => m.originalPath === newOriginalPath)) {
          return new Response(JSON.stringify({ error: 'A mirror with originalPath "' + newOriginalPath + '" already exists' }), {
            status: 409,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
      list[index] = {
        originalPath: newOriginalPath,
        delegatedPath: body.delegatedPath.replace(/\/+$/, ''),
      };
      await env.MIRRORS_KV.put('mirror_list', JSON.stringify(list));
      return new Response(JSON.stringify(list[index]), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // DELETE /api/mirrors?originalPath=xxx - delete a mirror
    if (request.method === 'DELETE') {
      const authError = await verifyPassword(request, env, corsHeaders);
      if (authError) return authError;

      const originalPath = url.searchParams.get('originalPath');
      if (!originalPath) {
        return new Response(JSON.stringify({ error: 'originalPath parameter is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const list = await env.MIRRORS_KV.get('mirror_list', { type: 'json' }) || [];
      const newList = list.filter(m => m.originalPath !== originalPath);
      if (newList.length === list.length) {
        return new Response(JSON.stringify({ error: 'Mirror not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await env.MIRRORS_KV.put('mirror_list', JSON.stringify(newList));
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