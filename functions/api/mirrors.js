export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // GET /api/mirrors - list all mirrors
    if (request.method === 'GET') {
      const list = await env.MIRRORS_KV.get('mirror_list', { type: 'json' }) || [];
      return new Response(JSON.stringify(list), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // POST /api/mirrors - add a new mirror
    if (request.method === 'POST') {
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
        return new Response(JSON.stringify({ error: 'Mirror with this originalPath already exists' }), {
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
      list[index] = {
        originalPath: body.originalPath.replace(/^\/+|\/+$/g, ''),
        delegatedPath: body.delegatedPath.replace(/\/+$/, ''),
      };
      await env.MIRRORS_KV.put('mirror_list', JSON.stringify(list));
      return new Response(JSON.stringify(list[index]), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // DELETE /api/mirrors?originalPath=xxx - delete a mirror
    if (request.method === 'DELETE') {
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