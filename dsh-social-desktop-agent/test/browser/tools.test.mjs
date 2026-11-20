/**
 * test/browser/tools.test.mjs
 *
 * ブラウザツール層の統合テスト。driver はスタブ、policy はフェイク、clock は注入。
 * ネットワーク呼び出しはゼロ（最後に fetch / WebSocket を差し替えて実証する）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BROWSE_TOOL_NAMES, createBrowseTools } from '../../lib/browser/tools.js';
import {
  IG_HOME,
  IG_LOGIN,
  IG_TWO_FACTOR,
  createAudit,
  createClock,
  createFakePolicy,
  createStub,
  makeTools,
} from './helpers.mjs';

/* ------------------------------------------------------------------ */
/* 公開面                                                              */
/* ------------------------------------------------------------------ */

test('公開するのは 7 ツールだけ（補助 API は enumerable でない）', () => {
  const tools = makeTools();
  assert.deepEqual(Object.keys(tools).sort(), [...BROWSE_TOOL_NAMES].sort());
  assert.equal(tools.toolNames, BROWSE_TOOL_NAMES);
  assert.equal(typeof tools.control.status, 'function');
  assert.equal(typeof tools.control.reset, 'function');
});

test('ドライバ / ポリシーの契約違反は生成時に落ちる', () => {
  assert.throws(
    () => createBrowseTools({ driver: {}, policy: createFakePolicy() }),
    (error) => error.code === 'DRIVER_INVALID',
  );
  assert.throws(
    () => createBrowseTools({ driver: createStub() }),
    (error) => error.code === 'POLICY_INVALID',
  );
});

/* ------------------------------------------------------------------ */
/* browse_open / allowlist                                             */
/* ------------------------------------------------------------------ */

test('browse_open: 許可ドメインを開き、操作回数を数える', async () => {
  const driver = createStub();
  const tools = makeTools({ driver });

  const result = await tools.browse_open({ url: IG_HOME });
  assert.equal(result.ok, true);
  assert.equal(result.tool, 'browse_open');
  assert.equal(result.url, IG_HOME);
  assert.equal(driver.count('open'), 1);

  const status = tools.control.status();
  assert.equal(status.ops, 1);
  assert.equal(status.url, IG_HOME);
  assert.equal(status.closed, false);
});

test('browse_open: allowlist 外のドメインは TARGET_DENIED で、ドライバを呼ばない', async () => {
  const driver = createStub();
  const tools = makeTools({ driver });

  const result = await tools.browse_open({ url: 'https://evil.example.com/' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TARGET_DENIED');
  assert.match(result.message, /許可されていないドメイン/);
  assert.equal(driver.count('open'), 0);
});

test('browse_open: HTTP(S) 以外の URL を拒否する', async () => {
  const driver = createStub();
  const tools = makeTools({ driver });

  for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,x']) {
    const result = await tools.browse_open({ url: bad });
    assert.equal(result.ok, false, bad);
    assert.equal(result.code, 'TARGET_DENIED', bad);
  }
  assert.equal(driver.count('open'), 0);
});

test('browse_open: allowlist を差し替えられる', async () => {
  const driver = createStub({ pages: [{ url: 'https://example.com/', title: 'Example', text: 'hi' }] });
  const tools = makeTools({ driver, allowlist: ['example.com'] });
  const result = await tools.browse_open({ url: 'https://example.com/' });
  assert.equal(result.ok, true);
  assert.equal(tools.control.status().allowedDomains[0], 'example.com');
});

/* ------------------------------------------------------------------ */
/* browse_snapshot                                                     */
/* ------------------------------------------------------------------ */

test('browse_snapshot: 開く前は TARGET_DENIED', async () => {
  const tools = makeTools();
  const result = await tools.browse_snapshot();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TARGET_DENIED');
  assert.match(result.message, /browse_open/);
});

test('browse_snapshot: role / name / ref の番号付きテキストを返す', async () => {
  const tools = makeTools();
  await tools.browse_open({ url: IG_HOME });
  const result = await tools.browse_snapshot();

  assert.equal(result.ok, true);
  assert.equal(result.count, 9);
  assert.match(result.snapshot, /^# page: https:\/\/www\.instagram\.com\/ — Instagram$/m);
  assert.match(result.snapshot, /^# nodes: 9$/m);
  assert.match(result.snapshot, /\[e1\] link "Home"/);
  assert.match(result.snapshot, /\[e3\] button "Like"/);
  assert.match(result.snapshot, /\[e6\] link "Photo by alice on March 1"/);
});

test('browse_snapshot: maxNodes で件数を絞れる', async () => {
  const tools = makeTools();
  await tools.browse_open({ url: IG_HOME });
  const result = await tools.browse_snapshot({ maxNodes: 2 });
  assert.equal(result.count, 2);
  assert.match(result.snapshot, /# nodes: 2/);
});

/* ------------------------------------------------------------------ */
/* スコープ: browse.read だけでは操作できない                          */
/* ------------------------------------------------------------------ */

test('read のみ: browse_click は SCOPE_DENIED、ドライバはクリックしない', async () => {
  const driver = createStub();
  const tools = makeTools({ driver, scopes: ['browse.read'] });

  await tools.browse_open({ url: IG_HOME });
  await tools.browse_snapshot();
  const result = await tools.browse_click({ ref: 'e1' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'SCOPE_DENIED');
  assert.equal(driver.count('click'), 0);
});

test('read のみ: browse_type も SCOPE_DENIED', async () => {
  const driver = createStub();
  const tools = makeTools({ driver, scopes: ['browse.read'] });

  await tools.browse_open({ url: IG_HOME });
  await tools.browse_snapshot();
  const result = await tools.browse_type({ ref: 'e5', text: 'cats' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'SCOPE_DENIED');
  assert.equal(driver.count('type'), 0);
});

test('read のみ: open / snapshot / screenshot / scroll は通る', async () => {
  const driver = createStub();
  const tools = makeTools({ driver, scopes: ['browse.read'] });

  assert.equal((await tools.browse_open({ url: IG_HOME })).ok, true);
  assert.equal((await tools.browse_snapshot()).ok, true);
  assert.equal((await tools.browse_screenshot()).ok, true);
  assert.equal((await tools.browse_scroll({ deltaY: 300 })).ok, true);
});

test('interact あり: browse_click が成功し、role / name を返す', async () => {
  const driver = createStub();
  const tools = makeTools({ driver });

  await tools.browse_open({ url: IG_HOME });
  await tools.browse_snapshot();
  const result = await tools.browse_click({ ref: 'e2' });

  assert.equal(result.ok, true);
  assert.equal(result.ref, 'e2');
  assert.equal(result.role, 'link');
  assert.equal(result.name, 'Explore');
  assert.equal(driver.count('click'), 1);
});

test('interact あり: browse_type は成功し、入力内容そのものは返さない', async () => {
  const driver = createStub();
  const tools = makeTools({ driver });

  await tools.browse_open({ url: IG_HOME });
  await tools.browse_snapshot();
  const result = await tools.browse_type({ ref: 'e5', text: 'cats', submit: true });

  assert.equal(result.ok, true);
  assert.equal(result.chars, 4);
  assert.equal(result.submitted, true);
  assert.equal('text' in result, false);
  assert.equal(driver.count('type'), 1);
});

test('browse_click: ref 未指定は INVALID_REF', async () => {
  const tools = makeTools();
  await tools.browse_open({ url: IG_HOME });
  const result = await tools.browse_click({});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_REF');
});

test('browse_click: 未知の ref はドライバ由来のエラーになる', async () => {
  const tools = makeTools();
  await tools.browse_open({ url: IG_HOME });
  const result = await tools.browse_click({ ref: 'e999' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_SUCH_REF');
});

/* ------------------------------------------------------------------ */
/* 恒久拒否: social.write                                              */
/* ------------------------------------------------------------------ */

test('social.engage: social.write スコープが無ければ Like は SCOPE_DENIED', async () => {
  const driver = createStub();
  const tools = makeTools({ driver });

  await tools.browse_open({ url: IG_HOME });
  await tools.browse_snapshot();
  const result = await tools.browse_click({ ref: 'e3' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'SCOPE_DENIED');
  assert.equal(driver.count('click'), 0);
});

test('social.engage: social.write スコープがあれば Like をクリックできる', async () => {
  const driver = createStub();
  const tools = makeTools({
    driver,
    policy: createFakePolicy({ scopes: ['browse.read', 'browse.interact', 'social.write'] }),
  });
  await tools.browse_open({ url: IG_HOME });
  await tools.browse_snapshot();
  const result = await tools.browse_click({ ref: 'e3' });

  assert.equal(result.ok, true);
  assert.equal(driver.count('click'), 1);
});

test('social.engage: Follow も同じ扱い（スコープ無しで拒否）', async () => {
  const tools = makeTools({ policy: createFakePolicy({ scopes: ['browse.read', 'browse.interact'] }) });
  await tools.browse_open({ url: IG_HOME });
  await tools.browse_snapshot();
  const result = await tools.browse_click({ ref: 'e4' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SCOPE_DENIED');
});

test('social.write: コメント等は social.write スコープがあっても恒久拒否', async () => {
  const driver = createStub();
  const tools = makeTools({
    driver,
    policy: createFakePolicy({ scopes: ['browse.read', 'browse.interact', 'social.write'] }),
  });
  await tools.browse_open({ url: IG_HOME });
  await tools.browse_snapshot();
  const result = await tools.browse_click({ ref: 'e7' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'TARGET_DENIED');
  assert.equal(result.permanent, true);
  assert.equal(driver.count('click'), 0);
});

test('social.write: purpose を明示した場合も拒否する', async () => {
  const tools = makeTools({ policy: createFakePolicy({ allowAll: true }) });
  await tools.browse_open({ url: IG_HOME });
  await tools.browse_snapshot();
  const result = await tools.browse_click({ ref: 'e1', purpose: 'social.write' });
  assert.equal(result.ok, false);
  assert.match(result.message, /ソーシャル書き込みはこのプラグインでは提供しない/);
});

test('social.write: コメント欄への入力も拒否する', async () => {
  const driver = createStub();
  const tools = makeTools({ driver, policy: createFakePolicy({ allowAll: true }) });
  await tools.browse_open({ url: IG_HOME });
  await tools.browse_snapshot();
  const result = await tools.browse_type({ ref: 'e7', text: 'nice!' });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'social.write');
  assert.equal(driver.count('type'), 0);
});

/* ------------------------------------------------------------------ */
/* 資格情報                                                            */
/* ------------------------------------------------------------------ */

test('資格情報: password 欄への入力は拒否し、人間に渡す', async () => {
  const driver = createStub();
  const tools = makeTools({ driver });

  await tools.browse_open({ url: IG_HOME });
  driver.setPage({
    url: IG_HOME,
    title: 'Instagram',
    nodes: [
      { ref: 'e1', role: 'textbox', name: '' },
      { ref: 'e2', role: 'textbox', name: 'Password', type: 'password' },
    ],
  });
  await tools.browse_snapshot();
  const result = await tools.browse_type({ ref: 'e2', text: 'hunter2' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'TARGET_DENIED');
  assert.equal(result.needsHuman, true);
  assert.match(result.reason, /パスワード/);
  assert.equal(driver.count('type'), 0);
});

test('資格情報: ページが認証面なら、ラベルの無い入力欄にも入力しない', async () => {
  // 実機で見つかった穴の再発防止: Instagram のログイン画面はラベルなし textbox +
  // password 欄で、per-field のラベル判定をすり抜ける。
  const driver = createStub();
  const tools = makeTools({ driver });

  await tools.browse_open({ url: IG_HOME });
  driver.setPage({
    url: IG_HOME,
    title: 'Instagram',
    nodes: [
      { ref: 'e1', role: 'textbox', name: '' },
      { ref: 'e2', role: 'textbox', name: '', type: 'password' },
    ],
  });
  await tools.browse_snapshot();
  const result = await tools.browse_type({ ref: 'e1', text: 'someone' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'TARGET_DENIED');
  assert.equal(result.needsHuman, true);
  assert.match(result.reason, /パスワード入力欄|資格情報/);
  assert.equal(driver.count('type'), 0);
});

test('資格情報: password 欄のクリックも拒否する', async () => {
  const driver = createStub();
  const tools = makeTools({ driver });
  await tools.browse_open({ url: IG_HOME });
  driver.setPage({
    url: IG_HOME,
    title: 'Instagram',
    nodes: [{ ref: 'e2', role: 'textbox', name: 'Password', type: 'password' }],
  });
  await tools.browse_snapshot();
  const result = await tools.browse_click({ ref: 'e2' });
  assert.equal(result.ok, false);
  assert.equal(result.needsHuman, true);
  assert.equal(driver.count('click'), 0);
});

/* ------------------------------------------------------------------ */
/* 人間介入                                                            */
/* ------------------------------------------------------------------ */

test('人間介入: ログイン画面を開くと needsHuman を返す', async () => {
  const tools = makeTools();
  const result = await tools.browse_open({ url: IG_LOGIN });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'NEEDS_HUMAN');
  assert.equal(result.needsHuman, true);
  assert.equal(result.kind, 'login');
  assert.match(result.reason, /人間の介入が必要/);
  assert.match(result.reason, /ログイン/);
});

test('人間介入: CAPTCHA を本文から検出して needsHuman', async () => {
  const driver = createStub();
  const tools = makeTools({ driver });

  await tools.browse_open({ url: IG_HOME });
  driver.setPage({
    url: IG_HOME,
    title: 'Instagram',
    text: 'Please verify you are human before continuing.',
    nodes: [],
  });
  const result = await tools.browse_snapshot();

  assert.equal(result.ok, false);
  assert.equal(result.code, 'NEEDS_HUMAN');
  assert.equal(result.kind, 'captcha');
});

test('人間介入: 2FA 検出後はすべての自動操作が止まる（ドライバを触らない）', async () => {
  const driver = createStub();
  const tools = makeTools({ driver });

  await tools.browse_open({ url: IG_HOME });
  driver.setPage({
    url: IG_TWO_FACTOR,
    title: 'Two-factor authentication',
    text: 'Enter the 6-digit code we sent to your phone.',
    nodes: [],
  });
  const detected = await tools.browse_snapshot();
  assert.equal(detected.code, 'NEEDS_HUMAN');
  assert.equal(detected.kind, '2fa');

  const before = driver.calls.length;
  const click = await tools.browse_click({ ref: 'e1' });
  const snapshot = await tools.browse_snapshot();
  const reopen = await tools.browse_open({ url: IG_HOME });

  assert.equal(click.code, 'NEEDS_HUMAN');
  assert.equal(snapshot.code, 'NEEDS_HUMAN');
  assert.equal(reopen.code, 'NEEDS_HUMAN');
  assert.equal(driver.calls.length, before, 'ラッチ後はドライバを一切呼ばない');
});

test('人間介入: browse_close でラッチを解除できる（人間の復帰経路）', async () => {
  const tools = makeTools();
  await tools.browse_open({ url: IG_LOGIN });
  assert.equal(tools.control.status().humanIntervention.kind, 'login');

  const closed = await tools.browse_close();
  assert.equal(closed.ok, true);
  assert.equal(tools.control.status().humanIntervention, null);
  assert.equal(tools.control.status().closed, true);
});

/* ------------------------------------------------------------------ */
/* レート制御                                                          */
/* ------------------------------------------------------------------ */

test('レート制限: 既定の最小間隔 1500ms に違反すると RATE_LIMITED', async () => {
  const clock = createClock(0);
  const tools = makeTools({ clock, rateLimit: null });

  assert.equal((await tools.browse_open({ url: IG_HOME })).ok, true);
  clock.advance(100);
  const result = await tools.browse_snapshot();

  assert.equal(result.ok, false);
  assert.equal(result.code, 'RATE_LIMITED');
  assert.equal(result.retryAfterMs, 1400);
  assert.equal(result.minIntervalMs, 1500);
});

test('レート制限: clock を進めれば通る', async () => {
  const clock = createClock(0);
  const tools = makeTools({ clock, rateLimit: null });

  await tools.browse_open({ url: IG_HOME });
  clock.advance(100);
  assert.equal((await tools.browse_snapshot()).code, 'RATE_LIMITED');

  clock.advance(1400); // 合計 1500ms
  const result = await tools.browse_snapshot();
  assert.equal(result.ok, true);
  assert.equal(tools.control.status().ops, 2);
});

test('レート制限: 1 セッションの操作上限に達すると RATE_LIMITED', async () => {
  const tools = makeTools({ rateLimit: { minIntervalMs: 0, maxOps: 2 } });

  assert.equal((await tools.browse_open({ url: IG_HOME })).ok, true);
  assert.equal((await tools.browse_snapshot()).ok, true);
  const result = await tools.browse_snapshot();

  assert.equal(result.ok, false);
  assert.equal(result.code, 'RATE_LIMITED');
  assert.equal(result.maxOps, 2);
  assert.equal(tools.control.status().ops, 2);
});

test('レート制限: 拒否された操作は操作回数を消費しない', async () => {
  const driver = createStub();
  const tools = makeTools({ driver, scopes: ['browse.read'], rateLimit: { minIntervalMs: 0, maxOps: 5 } });

  await tools.browse_open({ url: IG_HOME });
  const before = tools.control.status().ops;
  await tools.browse_snapshot();
  await tools.browse_click({ ref: 'e1' }); // SCOPE_DENIED
  await tools.browse_click({ ref: 'e2' }); // SCOPE_DENIED
  assert.equal(tools.control.status().ops, before + 1);
  assert.equal(driver.count('click'), 0);
});

/* ------------------------------------------------------------------ */
/* その他のツール                                                      */
/* ------------------------------------------------------------------ */

test('browse_screenshot: dataUrl を返す', async () => {
  const tools = makeTools();
  await tools.browse_open({ url: IG_HOME });
  const result = await tools.browse_screenshot({ fullPage: true });
  assert.equal(result.ok, true);
  assert.equal(result.mimeType, 'image/png');
  assert.match(result.dataUrl, /^data:image\/png;base64,/);
  assert.equal(result.fullPage, true);
});

test('browse_scroll: deltaY を渡して y を返す', async () => {
  const tools = makeTools();
  await tools.browse_open({ url: IG_HOME });
  const result = await tools.browse_scroll({ deltaY: 600 });
  assert.equal(result.ok, true);
  assert.equal(result.deltaY, 600);
  assert.equal(result.y, 600);
});

test('browse_close: 冪等で、閉じた後は全操作が CLOSED', async () => {
  const tools = makeTools();
  await tools.browse_open({ url: IG_HOME });

  assert.equal((await tools.browse_close()).ok, true);
  const again = await tools.browse_close();
  assert.equal(again.ok, true);
  assert.equal(again.alreadyClosed, true);

  const snapshot = await tools.browse_snapshot();
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.code, 'CLOSED');

  // browse_open で復帰できる（人間介入ラッチとは別）
  assert.equal((await tools.browse_open({ url: IG_HOME })).ok, true);
});

test('kill switch: ポリシーの KILL_SWITCH をそのまま伝播する', async () => {
  const driver = createStub();
  const tools = makeTools({
    driver,
    policy: createFakePolicy({ extra: () => ({ ok: false, code: 'KILL_SWITCH', message: 'キルスイッチが有効です' }) }),
  });

  const result = await tools.browse_open({ url: IG_HOME });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'KILL_SWITCH');
  assert.equal(driver.count('open'), 0);
});

test('allowlist: 遷移先が allowlist 外なら以降の操作を止める', async () => {
  const driver = createStub();
  const tools = makeTools({ driver });

  await tools.browse_open({ url: IG_HOME });
  await tools.browse_snapshot();
  const click = await tools.browse_click({ ref: 'e9' });
  assert.equal(click.ok, true);
  assert.equal(click.url, 'https://evil.example.com/');

  const snapshot = await tools.browse_snapshot();
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.code, 'TARGET_DENIED');
  assert.match(snapshot.message, /許可されていないドメイン/);
});

/* ------------------------------------------------------------------ */
/* 監査ログ                                                            */
/* ------------------------------------------------------------------ */

test('監査ログ: allow / deny / stop を記録する', async () => {
  const driver = createStub();
  const audit = createAudit();
  const tools = makeTools({ driver, audit });

  await tools.browse_open({ url: IG_HOME }); // allow
  await tools.browse_open({ url: 'https://evil.example.com/' }); // deny
  driver.setPage({
    url: IG_TWO_FACTOR,
    title: 'Two-factor authentication',
    text: 'Enter the 6-digit code we sent to your phone.',
    nodes: [],
  });
  await tools.browse_snapshot(); // stop

  assert.ok(audit.count('allow') >= 1, 'allow が記録される');
  assert.ok(audit.count('deny') >= 1, 'deny が記録される');
  assert.equal(audit.count('stop'), 1, 'stop が記録される');
  for (const entry of audit.entries) assert.equal(typeof entry.at, 'number');
});

test('監査ログ: 記録側が例外を投げてもツールは動き続ける', async () => {
  const tools = makeTools({
    audit: {
      record() {
        throw new Error('audit sink is down');
      },
    },
  });
  const result = await tools.browse_open({ url: IG_HOME });
  assert.equal(result.ok, true);
});

/* ------------------------------------------------------------------ */
/* ネットワークゼロ                                                    */
/* ------------------------------------------------------------------ */

test('ネットワーク呼び出しゼロ: fetch / WebSocket を一度も使わない', async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  let networkCalls = 0;

  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error('fetch は禁止');
  };
  globalThis.WebSocket = class ForbiddenWebSocket {
    constructor() {
      networkCalls += 1;
      throw new Error('WebSocket は禁止');
    }
  };

  try {
    const tools = makeTools();
    await tools.browse_open({ url: IG_HOME });
    await tools.browse_snapshot();
    await tools.browse_click({ ref: 'e2' });
    await tools.browse_type({ ref: 'e5', text: 'cats' });
    await tools.browse_scroll({ deltaY: 400 });
    await tools.browse_screenshot();
    await tools.browse_close();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }

  assert.equal(networkCalls, 0, 'ブラウザ層はツール実行中に通信しない');
});
