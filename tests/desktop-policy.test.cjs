const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { assetPath, externalUrl } = require('../electron/policy.cjs');

test('desktop asset requests stay inside the bundled app', () => {
  const root = path.resolve('dist');
  assert.equal(assetPath('yueye://app/', root), path.join(root, 'index.html'));
  assert.equal(assetPath('yueye://app/assets/main.js?v=1', root), path.join(root, 'assets/main.js'));
  for (const url of [
    'yueye://other/index.html', 'https://app/index.html', 'yueye://user@app/index.html',
    'yueye://app/%2e%2e%2fsecret', 'yueye://app/..%5csecret', 'yueye://app/C%3a/secret',
    'yueye://app/%00', 'yueye://app/%zz',
  ]) assert.equal(assetPath(url, root), null, url);
});

test('only ordinary HTTP and HTTPS links can leave the application', () => {
  assert.equal(externalUrl('https://example.com/book?q=1'), 'https://example.com/book?q=1');
  assert.equal(externalUrl('http://example.com'), 'http://example.com/');
  for (const url of ['file:///C:/Windows', 'javascript:alert(1)', 'ms-settings:test', 'data:text/html,test', 'https://user:secret@example.com', 'not a url']) {
    assert.equal(externalUrl(url), null, url);
  }
});
