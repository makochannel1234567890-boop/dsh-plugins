/**
 * test/browser/driver.test.mjs
 *
 * ドライバ契約の検証とスタブドライバの挙動。
 * cdp-driver.js は import と「接続前の検証」だけを確認する（実ブラウザなし・ネットワークなし）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DRIVER_METHODS,
  DriverError,
  assertDriver,
  assertPolicy,
  assertRef,
  normalizePageInfo,
  normalizeSnapshotResult,
} from '../../lib/browser/driver.js';
import { createStubDriver } from '../../lib/browser/stub-driver.js';
import { createCdpDriver } from '../../lib/browser/cdp-driver.js';
import { createStub, createFakePolicy, instagramPages, IG_HOME } from './helpers.mjs';

test('assertDriver: 必須メソッドが欠けていれば DRIVER_INVALID', () => {
  assert.throws(
    () => assertDriver({ open() {} }),
    (error) => {
      assert.equal(error instanceof DriverError, true);
      assert.equal(error.code, 'DRIVER_INVALID');
      assert.match(error.message, /getPage/);
      assert.match(error.message, /snapshot/);
      return true;
    },
  );
});

test('assertDriver: null / 非オブジェクトも拒否', () => {
  assert.throws(() => assertDriver(null), /ドライバが指定されていません/);
  assert.throws(() => assertDriver({}), /必須メソッドがありません/);
});

test('assertDriver: スタブは契約を満たす', () => {
  const driver = createStub();
  assert.equal(assertDriver(driver), driver);
  for (const method of DRIVER_METHODS) assert.equal(typeof driver[method], 'function', method);
});

test('assertPolicy: check が無ければ POLICY_INVALID', () => {
  assert.throws(() => assertPolicy({}), (error) => error.code === 'POLICY_INVALID');
  assert.throws(() => assertPolicy({ check: () => ({ ok: true }), require: 'nope' }), /policy.require/);
  assert.equal(assertPolicy(createFakePolicy()).check({ scope: 'browse.read' }).ok, true);
});

test('assertRef: 空文字・非文字列を拒否し、前後空白を落とす', () => {
  assert.equal(assertRef('  e3 '), 'e3');
  assert.throws(() => assertRef(''), (error) => error.code === 'INVALID_REF');
  assert.throws(() => assertRef(42), (error) => error.code === 'INVALID_REF');
});

test('normalizeSnapshotResult: ref の無いノードを捨て、重複 ref を落とす', () => {
  const snap = normalizeSnapshotResult({
    url: 'https://www.instagram.com/',
    title: 'Instagram',
    nodes: [
      { ref: 'e1', role: 'link', name: '  Home\n' },
      { ref: '', role: 'button', name: 'No ref' },
      null,
      'garbage',
      { role: 'button', name: 'No ref too' },
      { ref: 'e1', role: 'button', name: 'Duplicate' },
      { ref: 'e2', name: 'Like' },
    ],
  });
  assert.equal(snap.nodes.length, 2);
  assert.deepEqual(snap.nodes[0], {
    ref: 'e1',
    role: 'link',
    name: 'Home',
    value: undefined,
    url: undefined,
    type: undefined,
    disabled: false,
  });
  assert.equal(snap.nodes[1].role, 'unknown');
});

test('normalizeSnapshotResult: オブジェクト以外は DRIVER_INVALID_RESULT', () => {
  assert.throws(() => normalizeSnapshotResult(null), (error) => error.code === 'DRIVER_INVALID_RESULT');
});

test('normalizePageInfo: 欠損を fallback で埋める', () => {
  assert.deepEqual(normalizePageInfo({ url: 'https://x/' }, { title: 'T', text: 'body' }), {
    url: 'https://x/',
    title: 'T',
    text: 'body',
  });
});

test('スタブ: open → getPage → snapshot の往復', async () => {
  const driver = createStub();
  const open = await driver.open(IG_HOME);
  assert.equal(open.url, IG_HOME);
  assert.equal(open.title, 'Instagram');

  const page = await driver.getPage();
  assert.equal(page.url, IG_HOME);
  assert.match(page.text, /Photos and videos/);

  const snap = await driver.snapshot({ maxNodes: 3 });
  assert.equal(snap.nodes.length, 3);
  assert.equal(snap.nodes[0].ref, 'e1');
  assert.equal(driver.count('open'), 1);
  assert.equal(driver.count('snapshot'), 1);
});

test('スタブ: 未知の ref で click / type は NO_SUCH_REF', async () => {
  const driver = createStub();
  await driver.open(IG_HOME);
  await assert.rejects(() => driver.click('e999'), (error) => error.code === 'NO_SUCH_REF');
  await assert.rejects(() => driver.type('e999', 'x'), (error) => error.code === 'NO_SUCH_REF');
});

test('スタブ: describe はノードを返し、未知 ref は null', async () => {
  const driver = createStub();
  await driver.open(IG_HOME);
  assert.equal((await driver.describe('e3')).name, 'Like');
  assert.equal(await driver.describe('nope'), null);
});

test('スタブ: click の navigatesTo でページ遷移を再現する', async () => {
  const driver = createStub();
  await driver.open(IG_HOME);
  await driver.click('e9');
  const page = await driver.getPage();
  assert.equal(page.url, 'https://evil.example.com/');
});

test('スタブ: type / scroll / screenshot / close の戻り値', async () => {
  const driver = createStub();
  await driver.open(IG_HOME);

  const typed = await driver.type('e5', 'cats', { submit: true });
  assert.equal(typed.ref, 'e5');
  assert.equal(typed.submitted, true);

  const scrolled = await driver.scroll({ deltaY: 600 });
  assert.equal(scrolled.y, 600);
  assert.equal(driver.scrollY, 600);

  const shot = await driver.screenshot({ fullPage: true });
  assert.equal(shot.mimeType, 'image/png');
  assert.match(shot.dataUrl, /^data:image\/png;base64,/);

  await driver.close();
  assert.equal(driver.closed, true);
});

test('スタブ: failNext でエラー経路を注入できる', async () => {
  const driver = createStub();
  await driver.open(IG_HOME);
  driver.failNext('snapshot', 'BOOM', 'わざと失敗');
  await assert.rejects(() => driver.snapshot({}), (error) => error.code === 'BOOM');
  const ok = await driver.snapshot({});
  assert.equal(Array.isArray(ok.nodes), true);
});

test('スタブ: setPage で現在ページを差し替えられる', async () => {
  const driver = createStub({ pages: instagramPages() });
  await driver.open(IG_HOME);
  driver.setPage({ url: 'https://www.instagram.com/captcha/', title: 'x', text: '', nodes: [] });
  assert.equal((await driver.getPage()).url, 'https://www.instagram.com/captcha/');
});

test('CDP ドライバ: 生成だけでは接続しない（ネットワーク呼び出しゼロ）', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error('テストではネットワークを使ってはいけない');
  };
  try {
    const driver = createCdpDriver();
    assert.equal(assertDriver(driver), driver);
    assert.equal(driver.status().connected, false);
    assert.equal(driver.status().stats.connects, 0);

    // 危険なスキームは「接続前」に拒否される
    await assert.rejects(() => driver.open('javascript:alert(1)'), (error) => error.code === 'INVALID_URL');
    await assert.rejects(() => driver.open('file:///C:/Windows/win.ini'), (error) => error.code === 'INVALID_URL');
    await assert.rejects(
      () => driver.open('https://user:pass@www.instagram.com/'),
      (error) => error.code === 'INVALID_URL',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0, 'open() の検証段階で fetch を呼んではいけない');
});

test('CDP ドライバ: 既定では DSH シェル（type:"page"）を対象にしない', () => {
  const driver = createCdpDriver();
  assert.equal(driver.status().allowShell, false);
  assert.equal(driver.status().port, 9222);
  assert.equal(createCdpDriver({ port: 9333 }).status().port, 9333);
});

test('CDP ドライバ: 必須メソッドが揃っている', () => {
  const driver = createCdpDriver();
  for (const method of DRIVER_METHODS) assert.equal(typeof driver[method], 'function', method);
  assert.equal(typeof driver.status, 'function');
});

test('テストは実ブラウザを起動しない（スタブの URL は全てローカル定義）', () => {
  const pages = instagramPages();
  for (const page of pages) assert.match(page.url, /^https:\/\/www\.instagram\.com\//);
  const driver = createStubDriver({ pages });
  assert.equal(driver.count('open'), 0);
});
