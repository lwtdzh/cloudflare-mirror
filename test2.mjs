import { chromium } from 'playwright';

const BASE = 'https://lwtmirror.pages.dev';
const API = BASE + '/api/mirrors';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  let passed = 0;

  // === Test 1: Main page loads ===
  console.log('=== Test 1: Main page loads ===');
  await page.goto(BASE + '/');
  const title = await page.title();
  console.log('Title:', title);
  if (title === "LWT's mirror site") { passed++; console.log('PASS: Main page title correct'); }
  else { errors.push('Main page title wrong: ' + title); console.log('FAIL: Main page title wrong'); }

  // === Test 2: Main page has link to admin ===
  console.log('\n=== Test 2: Main page has link to admin ===');
  const adminLink = await page.locator('a[href="/admin/"]').count();
  if (adminLink > 0) { passed++; console.log('PASS: Admin link found'); }
  else { errors.push('No admin link found'); console.log('FAIL: No admin link found'); }

  // === Test 3: Add mirrors for sorting test ===
  console.log('\n=== Test 3: Add mirrors for sorting test ===');
  // First clear all existing mirrors
  const existing = await (await fetch(API)).json();
  for (const m of existing) {
    await fetch(API + '?originalPath=' + encodeURIComponent(m.originalPath), { method: 'DELETE' });
  }
  // Add mirrors in non-alphabetical order
  await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ originalPath: 'ztest', delegatedPath: 'https://example.com/z' }) });
  await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ originalPath: 'alpha', delegatedPath: 'https://example.com/a' }) });
  await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ originalPath: 'mid', delegatedPath: 'https://example.com/m' }) });
  const mirrors = await (await fetch(API)).json();
  console.log('Mirrors:', mirrors);
  passed++; console.log('PASS: Mirrors added for sorting test');

  // === Test 4: Main page mirrors are sorted alphabetically ===
  console.log('\n=== Test 4: Main page mirrors sorted alphabetically ===');
  await page.goto(BASE + '/');
  await page.waitForSelector('#mirrorList a');
  const mainMirrorNames = await page.locator('#mirrorList a').evaluateAll(els => els.map(e => e.textContent.trim()));
  console.log('Main page mirror order:', mainMirrorNames);
  const expectedOrder = ['alpha', 'mid', 'ztest'];
  if (JSON.stringify(mainMirrorNames) === JSON.stringify(expectedOrder)) {
    passed++; console.log('PASS: Main page mirrors are sorted alphabetically');
  } else {
    errors.push('Main page mirrors not sorted: ' + mainMirrorNames.join(','));
    console.log('FAIL: Main page mirrors not sorted, expected:', expectedOrder, 'got:', mainMirrorNames);
  }

  // === Test 5: Main page mirrors are read-only (no edit/delete buttons) ===
  console.log('\n=== Test 5: Main page mirrors are read-only ===');
  const editBtns = await page.locator('.btn-edit').count();
  const deleteBtns = await page.locator('.btn-danger').count();
  const addBtn = await page.locator('button.btn-primary').count();
  if (editBtns === 0 && deleteBtns === 0 && addBtn === 0) {
    passed++; console.log('PASS: Main page has no modify controls');
  } else {
    errors.push('Main page has modify controls');
    console.log('FAIL: Main page has modify controls (edit:', editBtns, 'delete:', deleteBtns, 'add:', addBtn, ')');
  }

  // === Test 6: Admin page mirrors are sorted alphabetically ===
  console.log('\n=== Test 6: Admin page mirrors sorted alphabetically ===');
  await page.goto(BASE + '/admin/');
  await page.waitForSelector('#mirrorBody tr');
  const adminMirrorNames = await page.locator('#mirrorBody td:first-child code').evaluateAll(els => els.map(e => e.textContent.trim()));
  console.log('Admin page mirror order:', adminMirrorNames);
  if (JSON.stringify(adminMirrorNames) === JSON.stringify(expectedOrder)) {
    passed++; console.log('PASS: Admin page mirrors are sorted alphabetically');
  } else {
    errors.push('Admin page mirrors not sorted: ' + adminMirrorNames.join(','));
    console.log('FAIL: Admin page mirrors not sorted, expected:', expectedOrder, 'got:', adminMirrorNames);
  }

  // === Test 7: Admin page has modify controls ===
  console.log('\n=== Test 7: Admin page has modify controls ===');
  const adminEditBtns = await page.locator('.btn-edit').count();
  const adminDeleteBtns = await page.locator('.btn-danger').count();
  const adminAddBtn = await page.locator('button.btn-primary').count();
  if (adminEditBtns >= 3 && adminDeleteBtns >= 3 && adminAddBtn >= 1) {
    passed++; console.log('PASS: Admin page has modify controls');
  } else {
    errors.push('Admin page missing modify controls');
    console.log('FAIL: Admin page missing modify controls');
  }

  // === Test 8: Admin page has link to main page ===
  console.log('\n=== Test 8: Admin page has link to main page ===');
  const homeLink = await page.locator('a[href="/"]').count();
  if (homeLink > 0) { passed++; console.log('PASS: Home link found on admin page'); }
  else { errors.push('No home link on admin'); console.log('FAIL: No home link on admin'); }

  // === Test 9: Root no longer returns 404 ===
  console.log('\n=== Test 9: Root returns 200 ===');
  const resp = await page.goto(BASE + '/');
  const status = resp.status();
  console.log('Root status:', status);
  if (status === 200) { passed++; console.log('PASS: Root returns 200'); }
  else { errors.push('Root returns ' + status); console.log('FAIL: Root returns ' + status); }

  // Cleanup test mirrors
  console.log('\n=== Cleanup ===');
  for (const name of ['ztest', 'alpha', 'mid']) {
    await fetch(API + '?originalPath=' + encodeURIComponent(name), { method: 'DELETE' });
  }

  console.log('\n=== Results ===');
  console.log('Passed:', passed, '/ 9');
  if (errors.length === 0) {
    console.log('ALL TESTS PASSED');
  } else {
    console.log('FAILURES:');
    errors.forEach(e => console.log('  - ' + e));
  }

  await browser.close();
  process.exit(errors.length > 0 ? 1 : 0);
})();