'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isTrustedSender } = require('../src/ipc-guard');

const PAGE = 'file:///app/renderer/index.html';
const mk = (url, isMain = true) => {
  const main = { url: PAGE };
  const frame = isMain ? main : { url };
  if (isMain) main.url = url;
  return { senderFrame: frame, sender: { mainFrame: main } };
};

test('acepta nuestra página en el marco principal', () => assert.ok(isTrustedSender(mk(PAGE), PAGE)));
test('rechaza otra URL', () => assert.ok(!isTrustedSender(mk('https://evil.example/'), PAGE)));
test('rechaza subframes (iframes)', () => assert.ok(!isTrustedSender(mk(PAGE, false), PAGE)));
test('rechaza eventos sin senderFrame (frame destruido)', () => {
  assert.ok(!isTrustedSender({ senderFrame: null, sender: {} }, PAGE));
  assert.ok(!isTrustedSender(undefined, PAGE));
});
