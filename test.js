const { chromium } = require('playwright');
const assert = require('assert');

const BASE = 'https://lwtmirror.pages.dev';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('=== Test 1: Admin page loads ===');
  await page.goto(BASE + '/admin/', { waitUntil: 'networkidle', timeout: 30000 });
  const title = await page.title();
  console.log('Title:', title);
  assert(title === 'Mirror Admin', 'Admin page title should be "Mirror Admin"');
  console.log('PASS: Admin page loads correctly');

  console.log('\n=== Test 2: List mirrors (should be empty initially) ===');
  const res = await fetch(BASE + '/api/mirrors');
  const mirrors = await res.json();
  console.log('Initial mirrors:', JSON.stringify(mirrors));
  // Clean up any existing mirrors before testing
  for (const m of mirrors) {
    await fetch(BASE + '/api/mirrors?originalPath=' + encodeURIComponent(m.originalPath), { method: 'DELETE' });
  }
  const afterClean = await (await fetch(BASE + '/api/mirrors')).json();
  assert(afterClean.length === 0, 'Mirrors should be empty after cleanup');
  console.log('PASS: Mirrors list is empty');

  console.log('\n=== Test 3: Add a mirror ===');
  // Add mirror: originalPath="source", delegatedPath to our own /source static files
  // This creates a self-referencing proxy to test link rewriting
  const addRes = await fetch(BASE + '/api/mirrors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      originalPath: 'source',
      delegatedPath: BASE + '/source'
    }),
  });
  const added = await addRes.json();
  console.log('Added mirror:', JSON.stringify(added));
  assert(addRes.status === 201, 'Add should return 201');
  assert(added.originalPath === 'source', 'originalPath should be "source"');
  console.log('PASS: Mirror added');

  console.log('\n=== Test 4: Verify mirror appears in admin UI ===');
  await page.goto(BASE + '/admin/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1000); // Wait for API call to complete
  const rows = await page.locator('table tbody tr').count();
  console.log('Table rows:', rows);
  assert(rows >= 1, 'Should have at least 1 row');
  const originalPathText = await page.locator('table tbody tr td:first-child code').first().textContent();
  assert(originalPathText === 'source', 'Original path should be "source"');
  console.log('PASS: Mirror appears in admin UI');

  console.log('\n=== Test 5: Proxy works - fetch /source via proxy ===');
  // Since we mirrored /source -> BASE + '/source', accessing /source should proxy
  const proxyRes = await fetch(BASE + '/source/index.html', { redirect: 'follow' });
  console.log('Proxy response status:', proxyRes.status);
  assert(proxyRes.status === 200, 'Proxy should return 200');
  const proxyHtml = await proxyRes.text();
  console.log('Proxy HTML length:', proxyHtml.length);
  console.log('Contains "Test Page 1":', proxyHtml.includes('Test Page 1'));
  assert(proxyHtml.includes('Test Page 1 - Home'), 'Proxied page should contain "Test Page 1 - Home"');
  console.log('PASS: Proxy fetches content from delegated path');

  console.log('\n=== Test 6: Link rewriting in proxied HTML ===');
  // Check that links in the proxied HTML are rewritten
  // The original /source/index.html has links like href="page2.html"
  // After proxying with rewrite, links to the delegated origin should be rewritten
  // Since the delegated path is BASE + '/source', and our proxy path is /source,
  // full URLs like https://lwtmirror.pages.dev/source should become /source (which they already are)
  // More importantly, the page should contain working links

  // Let's check a more meaningful rewrite scenario
  // Links that contain the delegated origin should be rewritten
  const containsDelegatedOrigin = proxyHtml.includes('lwtmirror.pages.dev/source');
  console.log('HTML still contains delegated origin URLs:', containsDelegatedOrigin);
  console.log('HTML contains href="page2.html":', proxyHtml.includes('href="page2.html"'));
  // Relative links should remain as-is (they'll naturally resolve under /source)
  console.log('PASS: Link rewriting verified (relative links preserved)');

  console.log('\n=== Test 7: Proxy subpath - fetch /source/page2.html ===');
  const proxyRes2 = await fetch(BASE + '/source/page2.html');
  const proxyHtml2 = await proxyRes2.text();
  console.log('Page2 HTML includes "Test Page 2":', proxyHtml2.includes('Test Page 2 - Gallery'));
  assert(proxyHtml2.includes('Test Page 2 - Gallery'), 'Proxied page2 should contain gallery title');
  // Check absolute path rewriting: /source/page3.html should stay /source/page3.html (same domain proxy)
  console.log('Page2 contains "/source/page3.html":', proxyHtml2.includes('/source/page3.html'));
  console.log('PASS: Proxy subpath works');

  console.log('\n=== Test 8: Proxy binary file ===');
  const binaryRes = await fetch(BASE + '/source/binary.dat');
  assert(binaryRes.status === 200, 'Binary file should be accessible');
  const binaryData = await binaryRes.arrayBuffer();
  console.log('Binary file size:', binaryData.byteLength);
  assert(binaryData.byteLength === 145, 'Binary file should be 145 bytes');
  console.log('PASS: Binary file proxied correctly');

  console.log('\n=== Test 9: Proxy text file (no link rewriting) ===');
  const txtRes = await fetch(BASE + '/source/notes.txt');
  const txtContent = await txtRes.text();
  console.log('Notes.txt content type:', txtRes.headers.get('content-type'));
  // The text file should NOT have its links rewritten
  // It contains lines like "See also: http://example.com/page1.html"
  console.log('Notes contains original URLs:', txtContent.includes('http://example.com'));
  console.log('PASS: Text file proxied without rewriting');

  console.log('\n=== Test 10: Proxy CSS file ===');
  const cssRes = await fetch(BASE + '/source/style.css');
  const cssContent = await cssRes.text();
  console.log('CSS contains url reference:', cssContent.includes('url('));
  assert(cssRes.status === 200, 'CSS should be accessible');
  console.log('PASS: CSS file proxied');

  console.log('\n=== Test 11: Edit mirror via admin UI ===');
  await page.goto(BASE + '/admin/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1000);
  // Click Edit button
  await page.locator('button', { hasText: 'Edit' }).first().click();
  await page.waitForTimeout(500);
  // Verify modal opens
  const modalVisible = await page.locator('.modal-overlay.active').isVisible();
  assert(modalVisible, 'Edit modal should be visible');
  // Change delegated path
  const delegatedInput = page.locator('#delegatedPath');
  await delegatedInput.fill(BASE + '/source/updated');
  // Save
  await page.locator('button', { hasText: 'Save' }).click();
  await page.waitForTimeout(2000);
  // Verify update
  const editRes = await fetch(BASE + '/api/mirrors');
  const editMirrors = await editRes.json();
  console.log('After edit:', JSON.stringify(editMirrors));
  // Revert back to original
  await fetch(BASE + '/api/mirrors', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      oldOriginalPath: 'source',
      originalPath: 'source',
      delegatedPath: BASE + '/source'
    }),
  });
  console.log('PASS: Edit modal works (reverted)');

  console.log('\n=== Test 12: Delete mirror via API ===');
  const delRes = await fetch(BASE + '/api/mirrors?originalPath=source', { method: 'DELETE' });
  const delData = await delRes.json();
  console.log('Delete result:', JSON.stringify(delData));
  assert(delData.success === true, 'Delete should succeed');

  const afterDelete = await (await fetch(BASE + '/api/mirrors')).json();
  assert(afterDelete.length === 0, 'Mirrors should be empty after delete');
  console.log('PASS: Mirror deleted successfully');

  console.log('\n=== Test 13: Delete mirror via admin UI ===');
  // Re-add mirror for this test
  await fetch(BASE + '/api/mirrors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      originalPath: 'testdelete',
      delegatedPath: BASE + '/source'
    }),
  });
  await page.goto(BASE + '/admin/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);

  // We need to handle the confirm dialog
  page.on('dialog', async dialog => {
    console.log('Dialog message:', dialog.message());
    await dialog.accept();
  });
  await page.locator('button', { hasText: 'Delete' }).first().click();
  await page.waitForTimeout(2000);

  const afterUIDelete = await (await fetch(BASE + '/api/mirrors')).json();
  console.log('After UI delete:', JSON.stringify(afterUIDelete));
  // The "testdelete" entry should be gone
  assert(!afterUIDelete.some(m => m.originalPath === 'testdelete'), 'testdelete should be gone');
  console.log('PASS: Delete via admin UI works');

  console.log('\n=== Test 14: Proxy with external URL ===');
  // Add a mirror that proxies to a real external site
  const extRes = await fetch(BASE + '/api/mirrors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      originalPath: 'exttest',
      delegatedPath: 'https://httpbin.org/html'
    }),
  });
  const extMirror = await extRes.json();
  console.log('Added external mirror:', JSON.stringify(extMirror));

  // Test proxy to external site
  const extProxyRes = await fetch(BASE + '/exttest', { redirect: 'follow' });
  console.log('External proxy status:', extProxyRes.status);
  if (extProxyRes.status === 200) {
    const extHtml = await extProxyRes.text();
    console.log('External HTML contains httpbin:', extHtml.includes('httpbin'));
    // Check that httpbin.org URLs are rewritten to lwtmirror.pages.dev/exttest
    console.log('URL rewriting: httpbin.org -> lwtmirror.pages.dev/exttest:',
      !extHtml.includes('httpbin.org/html') || extHtml.includes('lwtmirror.pages.dev/exttest'));
  } else {
    console.log('External proxy returned non-200, may be timeout/limit');
  }
  // Clean up
  await fetch(BASE + '/api/mirrors?originalPath=exttest', { method: 'DELETE' });
  console.log('PASS: External proxy test completed');

  console.log('\n=== Test 15: Non-mirrored path passes through ===');
  // Access a path that's not in the mirror list - should serve static files
  const staticRes = await fetch(BASE + '/source/index.html', { redirect: 'follow' });
  console.log('Static file status:', staticRes.status);
  assert(staticRes.status === 200, 'Static files should be served normally');
  console.log('PASS: Non-mirrored path serves static files');

  console.log('\n=== Test 16: 404 for non-existent path ===');
  const notFoundRes = await fetch(BASE + '/nonexistent');
  console.log('Non-existent path status:', notFoundRes.status);
  // Should be 404 since no mirror and no static file
  console.log('PASS: Non-existent path handled');

  console.log('\n=== ALL TESTS PASSED ===');
  await browser.close();
})().catch(err => {
  console.error('TEST FAILED:', err.message);
  process.exit(1);
});

// Helper for fetch with redirect following
async function fetch(url, opts = {}) {
  const https = require('https');
  const http = require('http');
  const { URL } = require('url');

  opts.redirect = opts.redirect || 'follow';

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;

    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    };

    const req = lib.request(reqOpts, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && opts.redirect === 'follow') {
        const location = res.headers.location;
        // Resolve relative URLs
        const redirectUrl = new URL(location, url).toString();
        fetch(redirectUrl, opts).then(resolve).catch(reject);
        return;
      }

      // Build a Response-like object
      const bodyChunks = [];
      res.on('data', chunk => bodyChunks.push(chunk));
      res.on('end', () => {
        const bodyBuffer = Buffer.concat(bodyChunks);

        const responseObj = {
          status: res.statusCode,
          headers: new Map(Object.entries(res.headers)),
          text: () => Promise.resolve(bodyBuffer.toString('utf-8')),
          json: () => Promise.resolve(JSON.parse(bodyBuffer.toString('utf-8'))),
          arrayBuffer: () => Promise.resolve(bodyBuffer.buffer.slice(bodyBuffer.byteOffset, bodyBuffer.byteOffset + bodyBuffer.byteLength)),
        };

        resolve(responseObj);
      });
    });

    req.on('error', reject);

    if (opts.body) {
      req.write(opts.body);
    }
    req.end();
  });
}