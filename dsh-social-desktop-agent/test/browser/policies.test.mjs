/**
 * test/browser/policies.test.mjs
 *
 * 純粋判定ロジックのテスト（ネットワークなし・実ブラウザなし）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ALLOWED_DOMAINS,
  DEFAULT_RATE_LIMIT,
  SOCIAL_WRITE_REASON,
  classifySocialLabel,
  detectCredentialInput,
  detectHumanIntervention,
  detectSocialWrite,
  isHostAllowed,
  matchDomainPattern,
  parseTargetUrl,
  renderSnapshot,
} from '../../lib/browser/policies.js';

test('既定 allowlist は Instagram 系を含み、ワイルドカードを持つ', () => {
  assert.ok(DEFAULT_ALLOWED_DOMAINS.includes('instagram.com'));
  assert.ok(DEFAULT_ALLOWED_DOMAINS.includes('www.instagram.com'));
  assert.ok(DEFAULT_ALLOWED_DOMAINS.includes('*.cdninstagram.com'));
});

test('既定のレート制限は 1500ms / 200 回', () => {
  assert.equal(DEFAULT_RATE_LIMIT.minIntervalMs, 1500);
  assert.equal(DEFAULT_RATE_LIMIT.maxOps, 200);
});

test('ドメイン照合: 許可されるホスト', () => {
  for (const host of [
    'instagram.com',
    'www.instagram.com',
    'i.instagram.com',
    'scontent.cdninstagram.com',
    'cdninstagram.com',
    'scontent.fbcdn.net',
  ]) {
    assert.equal(isHostAllowed(host, DEFAULT_ALLOWED_DOMAINS), true, host);
  }
});

test('ドメイン照合: 拒否されるホスト（サフィックス偽装を含む）', () => {
  for (const host of [
    'evil.com',
    'instagram.com.evil.com',
    'evilinstagram.com',
    'www.instagram.com.evil.io',
    'cdninstagram.com.attacker.net',
    '',
  ]) {
    assert.equal(isHostAllowed(host, DEFAULT_ALLOWED_DOMAINS), false, host);
  }
});

test('ワイルドカード `*.x` は x 自身と全サブドメインに一致する', () => {
  assert.equal(matchDomainPattern('cdninstagram.com', '*.cdninstagram.com'), true);
  assert.equal(matchDomainPattern('a.cdninstagram.com', '*.cdninstagram.com'), true);
  assert.equal(matchDomainPattern('a.b.cdninstagram.com', '*.cdninstagram.com'), true);
  assert.equal(matchDomainPattern('xcdninstagram.com', '*.cdninstagram.com'), false);
  assert.equal(matchDomainPattern('cdninstagram.com.evil', '*.cdninstagram.com'), false);
});

test('URL 検証: スキーム無しは https を補う', () => {
  const parsed = parseTargetUrl('www.instagram.com/explore/');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.url, 'https://www.instagram.com/explore/');
  assert.equal(parsed.host, 'www.instagram.com');
});

test('URL 検証: HTTP(S) 以外は拒否', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<h1>x</h1>', 'file:///C:/secret.txt', 'ftp://x/y']) {
    const parsed = parseTargetUrl(bad);
    assert.equal(parsed.ok, false, bad);
    assert.equal(parsed.code, 'TARGET_DENIED');
  }
});

test('URL 検証: 資格情報つき URL は拒否', () => {
  const parsed = parseTargetUrl('https://user:pass@www.instagram.com/');
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /資格情報/);
});

test('URL 検証: 空・未指定は拒否', () => {
  assert.equal(parseTargetUrl(null).ok, false);
  assert.equal(parseTargetUrl('   ').ok, false);
});

test('ソーシャル書き込み判定: 書き込み系ラベルを検出する', () => {
  for (const label of ['Like', 'Unlike', 'Follow', 'Following', 'Comment', 'Reply', 'Post', 'Share', 'Save', 'Send', 'Bookmark', 'いいね', 'フォロー', 'コメント', '返信', '投稿', 'シェア', '送信']) {
    assert.equal(classifySocialLabel(label) !== null, true, label);
  }
});

test('ソーシャル書き込み判定: 閲覧系ラベルは通す', () => {
  for (const label of ['Home', 'Explore', 'Search', 'Messages', 'Photo by alice on March 1', '保存済み', '投稿一覧', '']) {
    assert.equal(classifySocialLabel(label), null, label);
  }
});

test('ソーシャル操作判定: いいね等は engage として分類される', () => {
  const verdict = detectSocialWrite({ node: { ref: 'e3', role: 'button', name: 'Like' } });
  assert.equal(verdict.isWrite, true);
  assert.equal(verdict.kind, 'social.engage');
  assert.match(verdict.reason, /social\.write スコープ/);
});

test('ソーシャル操作判定: コメント/送信は恒久拒否の write のまま', () => {
  for (const label of ['Comment', 'Send', 'コメントする', '送信する']) {
    const verdict = detectSocialWrite({ node: { ref: 'e9', role: 'button', name: label } });
    assert.equal(verdict.isWrite, true, label);
    assert.equal(verdict.kind, 'social.write', label);
  }
});

test('ソーシャル書き込み判定: purpose 指定でも検出する', () => {
  const verdict = detectSocialWrite({ purpose: 'social.write', node: { ref: 'e1', role: 'link', name: 'Home' } });
  assert.equal(verdict.isWrite, true);
  assert.equal(verdict.reason, SOCIAL_WRITE_REASON);
});

test('ソーシャル書き込み判定: 通常のリンクは書き込みではない', () => {
  const verdict = detectSocialWrite({ node: { ref: 'e1', role: 'link', name: 'Explore' } });
  assert.equal(verdict.isWrite, false);
});

test('資格情報検出: password type / パスワード / ユーザー名 / 認証コード', () => {
  assert.equal(detectCredentialInput({ type: 'password' }).isCredential, true);
  assert.equal(detectCredentialInput({ node: { name: 'パスワード' } }).isCredential, true);
  assert.equal(detectCredentialInput({ node: { name: 'Phone number, username, or email' } }).isCredential, true);
  assert.equal(detectCredentialInput({ node: { name: '認証コード' } }).isCredential, true);
});

test('資格情報検出: 通常の入力欄は通す', () => {
  assert.equal(detectCredentialInput({ node: { name: 'Search' } }).isCredential, false);
  assert.equal(detectCredentialInput({ node: { name: 'Add a comment' } }).isCredential, false);
});

test('人間介入検出: ログイン / 2FA / チェックポイント / CAPTCHA の URL', () => {
  const cases = [
    ['https://www.instagram.com/accounts/login/', 'login'],
    ['https://www.instagram.com/two_factor/', '2fa'],
    ['https://www.instagram.com/challenge/action/123/', 'checkpoint'],
    ['https://www.instagram.com/captcha/', 'captcha'],
  ];
  for (const [url, kind] of cases) {
    const hit = detectHumanIntervention({ url });
    assert.equal(hit.needed, true, url);
    assert.equal(hit.kind, kind, url);
    assert.match(hit.reason, /人間の介入が必要/);
  }
});

test('人間介入検出: 本文パターン（CAPTCHA / 2FA / 本人確認 / ログイン要求）', () => {
  assert.equal(detectHumanIntervention({ text: 'Please verify you are human' }).kind, 'captcha');
  assert.equal(detectHumanIntervention({ text: '私はロボットではありません' }).kind, 'captcha');
  assert.equal(detectHumanIntervention({ text: 'Enter the 6-digit code we sent you' }).kind, '2fa');
  assert.equal(detectHumanIntervention({ text: '2要素認証を設定してください' }).kind, '2fa');
  assert.equal(detectHumanIntervention({ text: 'Suspicious activity detected on your account' }).kind, 'checkpoint');
  assert.equal(detectHumanIntervention({ text: 'ログインが必要です' }).kind, 'login');
});

test('人間介入検出: 通常のページでは発動しない', () => {
  const hit = detectHumanIntervention({
    url: 'https://www.instagram.com/',
    title: 'Instagram',
    text: 'Photos and videos from your friends. Explore the feed.',
  });
  assert.equal(hit.needed, false);
  assert.equal(hit.reason, null);
});

test('スナップショット整形: role / name / ref を番号付きで出す', () => {
  const text = renderSnapshot({
    url: 'https://www.instagram.com/',
    title: 'Instagram',
    nodes: [
      { ref: 'e1', role: 'link', name: 'Explore', url: 'https://www.instagram.com/explore/' },
      { ref: 'e2', role: 'button', name: 'Like' },
      { ref: 'e3', role: 'textbox', name: 'Search', value: 'cats' },
      { ref: 'e4', role: 'button', name: 'Save', disabled: true },
    ],
  });

  assert.match(text, /^# page: https:\/\/www\.instagram\.com\/ — Instagram$/m);
  assert.match(text, /^# nodes: 4$/m);
  assert.match(text, /^\[e1\] link "Explore" -> https:\/\/www\.instagram\.com\/explore\/$/m);
  assert.match(text, /^\[e2\] button "Like"$/m);
  assert.match(text, /^\[e3\] textbox "Search" value="cats"$/m);
  assert.match(text, /^\[e4\] button "Save" \[disabled\]$/m);
});

test('スナップショット整形: 改行・二重引用符を潰す', () => {
  const text = renderSnapshot({ nodes: [{ ref: 'e1', role: 'button', name: 'Say "hi"\nnow' }] });
  assert.match(text, /\[e1\] button "Say 'hi' now"/);
});

test('スナップショット整形: 上限で切り詰める', () => {
  const nodes = Array.from({ length: 50 }, (_, i) => ({ ref: `e${i + 1}`, role: 'button', name: `ボタン${i}` }));
  const text = renderSnapshot({ nodes, maxChars: 120 });
  assert.ok(text.length <= 120 + 40, '切り詰め後の長さが暴れていない');
  assert.match(text, /truncated/);
});
