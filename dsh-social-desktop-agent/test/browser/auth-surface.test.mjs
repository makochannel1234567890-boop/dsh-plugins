/**
 * 認証面（ログイン / パスワード欄）検出の回帰テスト。
 *
 * 実機で見つかった穴の再発防止:
 *   Instagram のログイン画面は「ラベルが空の textbox + password 欄」で、
 *   ラベル（name/placeholder）だけを見る detectCredentialInput をすり抜け、
 *   ユーザー名欄への入力が通ってしまった。detectAuthSurface はページ単位で
 *   password 欄の有無を見ることでこれを塞ぐ。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { detectAuthSurface } from '../../lib/browser/policies.js'

test('password 欄があれば、ラベルが空でも認証面と判定する', () => {
  const result = detectAuthSurface({
    url: 'https://www.instagram.com/',
    nodes: [
      { ref: 'e1', role: 'textbox', name: '', type: 'text' },
      { ref: 'e2', role: 'textbox', name: '', type: 'password' },
    ],
  })
  assert.equal(result.isAuth, true)
  assert.match(String(result.reason), /パスワード入力欄|資格情報/)
})

test('password 欄が無く、本文も通常なら認証面ではない', () => {
  const result = detectAuthSurface({
    url: 'https://www.instagram.com/p/Cxyz/',
    nodes: [{ ref: 'e1', role: 'button', name: '戻る', type: null }],
    text: '写真と動画 1,234 件のいいね',
  })
  assert.equal(result.isAuth, false)
  assert.equal(result.reason, null)
})

test('ログイン要求の本文を検出する', () => {
  const result = detectAuthSurface({
    url: 'https://www.instagram.com/',
    nodes: [],
    text: 'Instagram にログインが必要です',
  })
  assert.equal(result.isAuth, true)
})

test('2FA の本文を検出する', () => {
  const result = detectAuthSurface({
    url: 'https://www.instagram.com/',
    nodes: [],
    text: '認証コードを入力してください',
  })
  assert.equal(result.isAuth, true)
})

test('ログイン URL を検出する', () => {
  const result = detectAuthSurface({ url: 'https://www.instagram.com/accounts/login/', nodes: [] })
  assert.equal(result.isAuth, true)
  assert.match(String(result.reason), /ログイン/)
})

test('node の type が password でも text でも安全に判定する（例外を投げない）', () => {
  assert.equal(detectAuthSurface().isAuth, false)
  assert.equal(detectAuthSurface({ nodes: [null, undefined, {}, { type: 'PASSWORD' }] }).isAuth, true)
})
