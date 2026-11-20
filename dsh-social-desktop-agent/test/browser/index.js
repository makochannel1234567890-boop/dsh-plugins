/**
 * test/browser/index.js
 *
 * なぜこのファイルがあるか:
 *   Node 24.18.0 では `node --test <dir>` の位置引数が「テストファイル / glob」として解決されるため、
 *   ディレクトリを渡すとディレクトリ自身を実行しようとして MODULE_NOT_FOUND で落ちる
 *   （`node --test test/browser` が失敗する。実測済み）。
 *   このディレクトリに index.js を置くと Node のモジュール解決が `<dir>` → `index.js` に落ちるので、
 *   受入コマンド `node --test dsh-social-desktop-agent/test/browser` がそのまま通る。
 *
 * ここから各テストを import すると、各ファイルのトップレベル test() が同じランナーに登録される。
 */
import './policies.test.mjs';
import './driver.test.mjs';
import './tools.test.mjs';
