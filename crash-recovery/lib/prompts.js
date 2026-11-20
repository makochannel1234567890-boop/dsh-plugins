/**
 * Resume prompt construction for dsh-crash-recovery.
 *
 * A plain "continue where you left off" is provably insufficient: the two UE
 * sessions that stayed down for hours were a fanout caller and a fanout worker,
 * and neither could reconstruct its own brief from the conversation. Each
 * prompt therefore states (a) that this is a crash recovery, (b) exactly what
 * the run graph says this session was, and (c) that the previous tool call may
 * have hung, so it must be re-derived instead of replayed.
 *
 * @module dsh-crash-recovery/lib/prompts
 */

import { KIND_FANOUT_CALLER, KIND_FANOUT_INTEGRATOR, KIND_FANOUT_REVIEW, KIND_FANOUT_WORKER } from './resume-plan.js'

const COMMON_RULES = `守ること:
- これはクラッシュ復旧です。停止前のツール呼び出しはタイムアウトして終わっている可能性があります。同じコマンドをそのまま撃ち直さず、まず現物（ファイル・コマンド出力・共有ファイル）を読み直してください。
- 進めた内容を 1〜2 行で share_progress に記録してください（使える場合）。
- 復旧であるため、人間の新しい指示なしに新しい作業範囲を広げないでください。`

function runLine(entry) {
  const parts = []
  if (entry.runIds !== undefined && entry.runIds.length > 0) parts.push(`run: ${entry.runIds.join(', ')}`)
  else if (entry.runId) parts.push(`run: ${entry.runId}`)
  if (entry.runStatus) parts.push(`状態: ${entry.runStatus}`)
  if (entry.objective) parts.push(`目的: ${entry.objective.slice(0, 220)}`)
  if (entry.cwd) parts.push(`cwd: ${entry.cwd}`)
  return parts.join(' / ')
}

/**
 * @param {any} entry one plan entry from buildResumePlan
 * @param {{ crashAt?: number, reportPath?: string }} [context]
 */
export function buildResumePrompt(entry, context = {}) {
  const head = `（dsh-crash-recovery）DSH が予期せず終了し、このセッションは停止していました。復旧のために再開しています。`
  const extra = context.reportPath ? `\n復旧レポート: ${context.reportPath}` : ''

  switch (entry.kind) {
    case KIND_FANOUT_WORKER:
      return `${head}

あなたは fanout のワーカー（task ${entry.taskId || '?'} / attempt ${entry.attemptId || '?'}）でした。
${runLine(entry)}
run は停止しましたが、あなたの担当タスクの状態は run.json に残っています。

やること:
1. run のディレクトリ（\`~/.dsh/storages/fanout/runs/${entry.runId}/\`）の run.json と results/ を読み、自分のタスクが完了済みか未完了かを確認する。
2. 完了済みなら、成果物のパスを短く報告して終了する（同じ作業をやり直さない）。
3. 未完了なら、残っている作業だけを実行して結果を results/ に書き、短く報告して終了する。
4. fanout_control でラン全体を操作しない（それは呼び出し元の役目）。

${COMMON_RULES}${extra}`

    case KIND_FANOUT_REVIEW:
      return `${head}

あなたは fanout のレビュアーでした。
${runLine(entry)}

やること:
1. \`~/.dsh/storages/fanout/runs/${entry.runId}/\` の run.json と results/ を読み、対象タスクの実装結果を確認する。
2. 判定（pass / needs_revision / reject）と根拠を短くまとめる。既に出した判定が run.json に残っていればそれを報告して終了する。
3. 新しいコード変更はしない。

${COMMON_RULES}${extra}`

    case KIND_FANOUT_INTEGRATOR:
      return `${head}

あなたは fanout の統合役でした。
${runLine(entry)}

やること:
1. run.json・results/・検証ログを読み、どの検証が実行済みでどれが未実行かを確定する。
2. 未実行の検証だけを実行し、コマンドと終了コードの表を final.md に書く。
3. 統合レポートを短く報告して終了する。

${COMMON_RULES}${extra}`

    case KIND_FANOUT_CALLER:
      return `${head}

あなたは fanout の呼び出し元セッションで、次のランを開始していました。
${runLine(entry)}
${entry.runIds.length > 1 ? `\n関与したラン: ${entry.runIds.join(', ')}` : ''}

やること:
1. まず fanout_status で、これらのランの現在の状態・タスク・判定を確認する。
2. 停止中（stopped）のランは、再開してよいものだけ fanout_control action="resume" で再開する。失敗（failed）のランは、失敗したタスクを fanout_control action="retry" で1つずつ再試行する。
3. 再開するかの判断がつかない場合や、ランが既に completed の場合は、そのまま何もせず、状態を 3〜5 行で報告して終了する。
4. 新しい fanout_start はしない（人間の指示があるまで）。

${COMMON_RULES}${extra}`

    default:
      return `${head}

やること:
1. 直前に触っていたファイルや作業ディレクトリ（${entry.cwd || '不明'}）の現物を読み、どこまで終わっているか確認する。
2. 未完了の作業だけを続ける。完了しているなら再実行しない。
3. 何を再開したかを 1〜2 行で報告する。

${COMMON_RULES}${extra}`
  }
}

/**
 * Brief for the single supervisor session created right after a crash.
 *
 * @param {{
 *   crashAt?: number,
 *   reportPath: string,
 *   observed: { risky?: string[], running?: string[], fanoutRuns?: string[] },
 *   planPreview?: Array<{ sessionId: string, kind: string, runId?: string }>,
 * }} input
 */
export function buildSupervisorBrief(input) {
  const risky = (input.observed?.risky ?? []).map((id) => `- ${id}`).join('\n') || '- なし'
  const runs = (input.observed?.fanoutRuns ?? []).map((id) => `- ${id}`).join('\n') || '- なし'
  const planned = (input.planPreview ?? [])
    .map((item) => `- ${item.sessionId} (${item.kind}${item.runId ? `, ${item.runId}` : ''})`)
    .join('\n') || '- なし'
  const when =
    Number.isFinite(input.crashAt) && input.crashAt > 0
      ? new Date(input.crashAt).toISOString()
      : '不明'

  return `（dsh-crash-recovery）DSH が予期せず終了しました（最終 heartbeat: ${when}）。あなたはこのクラッシュの**復旧を監督する唯一のセッション**です。他のセッションの再開は、あなたの完了後に自動で行われます。

## クラッシュ時に動いていたもの
危険ツール（PC を直接操作する系）を撃っていたセッション:
${risky}

実行中だった fanout ラン:
${runs}

## 復旧対象（この後こちらで再開します）
${planned}

## あなたの仕事（この順で、短く）
1. \`fanout_status\` を実行し、上記ランの状態・タスク・判定・最終レポートの有無を確認する。
2. 壊れた状態があれば直す: 孤児の running タスクは \`fanout_control action="retry" task_id=...\`、停止したランは必要なら \`fanout_control action="resume"\`。**新しい fanout_start はしない。**
3. 作業ツリーに半端な変更が残っていないか確認する（\`git status\` など）。破壊的な後始末（reset --hard・削除）はしない。判断に迷ったら「人間の確認が必要」と書く。
4. 次の形式で復旧レポートを \`${input.reportPath}\` に書く:

\`\`\`
# クラッシュ復旧レポート
- 契機: <最終 heartbeat>
- 対象ラン: <id: 状態 → 対応>
- 孤児タスク: <task id: retry した/放置した理由>
- 未完了の作業: <箇条書き>
- 人間の確認が必要な点: <箇条書き、なければ「なし」>
\`\`\`

5. 最後に 3〜5 行で要約して終了する。**長い再調査はしない**（復旧の監督であって、タスクのやり直しではない）。

## 制約
- 破壊的操作（削除、reset --hard、デプロイ、電源操作）はしない。
- クラッシュ原因の推測は書いてよいが、修正の実装はしない（別タスク）。
- 復旧レポートを書いたら、あなたの役目は終わり。`
}
