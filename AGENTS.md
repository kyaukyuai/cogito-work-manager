# AGENTS.md

この repo は Slack 上の会話 bot ではなく、Linear を system of record とする execution manager として扱う。

設計方針の一次文書は [docs/execution-manager-architecture.md](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/docs/execution-manager-architecture.md) とし、実装順序と完了条件は [docs/refactor-roadmap.md](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/docs/refactor-roadmap.md) を参照する。この `AGENTS.md` は日々の実装判断で厳守するルールを定義する。

## Current Mode

- 2026-03-19 時点で、Phase 1-4 の refactor は完了済みと扱う
- 以後の変更は、原則として新たな大規模構造変更ではなく、運用耐性、可観測性、保守性改善を優先する
- 新しい構造再編を始める場合は、既存 architecture / roadmap のどの完了条件が不足しているかを先に明記する

## Mission

- Slack の依頼を安定して work item に変換する
- progress / blocked / completed / research / follow-up を一貫した状態モデルで扱う
- Linear を唯一の task system of record として維持する
- LLM を使っても挙動の contract を壊さない

## Non-Negotiables

- 本番の中核ロジックを skill や自由文 prompt に依存させない
- Linear 以外の内部 todo system を作らない
- LLM の自由文出力をそのまま外部副作用へつなげない
- 巨大な manager 関数や巨大な prompt ファイルへ機能を継ぎ足さない

## Architecture Rules

- `main.ts` は薄く保つ。起動、配線、ルーティング以外の業務ロジックを入れない。
- workflow ごとの処理は `orchestrators/` に分ける。
- LLM を使う判断処理は `planners/` に分ける。
- 外部 API / CLI / Slack context / web research は `gateways/` に集約する。
- policy, ledger, repository, projection は `state/` に置く。
- runtime 構築と isolated turn 実行は `runtime/` に閉じ込める。
- 型やルールの中心は `domain/` に置く。

既存コードがこの構成に達していなくても、新しい変更はこの方向へ寄せる。新機能を `src/lib/manager.ts` や `src/lib/pi-session.ts` に直接積み増すのは最後の手段とする。

## LLM Rules

- LLM は `plan` と `assess` にのみ使う。
- create / update / comment / assign / relation / state change は必ずコード側の command で実行する。
- planner は必ず schema 付き JSON を返す。
- planner ごとに `contract.ts`, `prompt.ts`, `parser.ts`, `runner.ts` を分ける。
- parser は保守的に実装し、曖昧な応答は失敗または clarify に倒す。
- planner の返却型を変える場合は、prompt, parser, tests を同時に更新する。

## Side Effects and State

- 外部副作用は idempotent に扱う。
- duplicate 防止、再送耐性、再実行耐性を常に考慮する。
- Slack thread は入力チャネルであり、状態の主語ではない。
- ローカル state は orchestration 補助に限定する。
- canonical な work state は常に Linear に置く。
- local file は thread と issue の対応、follow-up 状態、planner 判断履歴、review 抑制情報などに限定する。
- state の read/write は repository 経由に寄せ、workflow から JSON を直接触らない方向で進める。

## Code Placement

- intake 処理は `orchestrators/intake/` へ置く。
- progress / completed / blocked は `orchestrators/updates/` に分ける。
- research 関連は `orchestrators/research/` と `planners/research-synthesis/` に分ける。
- follow-up request / resolution は `orchestrators/followups/` と `planners/followup-resolution/` に分ける。
- review / heartbeat の判断は `orchestrators/review/` に置く。
- Linear custom tools や Linear command/query は `gateways/linear/` に寄せる。

新しい workflow を追加する場合は、最低限次を同時に定義する。

- input contract
- output contract
- dedupe strategy
- side-effect boundary
- persistence boundary
- tests

## Legacy Code Guidance

- `src/lib/manager.ts` と `src/lib/pi-session.ts` は移行中の集約点として扱う。
- 既存の `skills/linear-cli/` や skill コピー処理は互換資産として残っていてよいが、新設計の前提にはしない。
- legacy ファイルを触る場合も、新しい責務はできるだけ新しい分割先へ逃がす。
- 「今あるからここに足す」は理由にならない。責務境界を優先する。

## Testing Requirements

- planner には parser テストと prompt/fixture テストを付ける。
- orchestrator には workflow 単位のテストを付ける。
- side-effect を伴う変更は duplicate と retry のケースを少なくとも 1 つ検証する。
- relative date や due date を扱う変更は Asia/Tokyo 前提でテストする。
- review / follow-up / blocked 判定は回帰しやすいため、期待 JSON や fixture を固定する。

## Decision Heuristics

- 判断を LLM に任せる前に、必要な contract が定義されているか確認する。
- state を増やす前に、その state が Linear では表現できない orchestration 補助か確認する。
- 新しい抽象を足す前に、それが workflow 境界か外部依存境界か状態境界かを明確にする。
- 会話として自然かより、再実行して壊れないかを優先する。

## Default Refactor Direction

変更時に迷ったら、次の順で改善する。

1. `src/lib/pi-session.ts` から planner を切り出す
2. `src/lib/manager.ts` から workflow を切り出す
3. `src/lib/manager-state.ts` から repository を切り出す
4. gateway と orchestrator の境界を明確にする

上記は未整理な legacy 領域に触るときの整理順であり、refactor roadmap を再開する宣言ではない。通常の優先順位は `workgraph` の運用改善、health check、observability、replay/snapshot 整備とする。

## Documentation Rule

- 設計判断を変える変更では、必要に応じて [docs/execution-manager-architecture.md](/Users/kyaukyuai/src/github.com/kyaukyuai/pi-slack-linear/docs/execution-manager-architecture.md) も更新する。
- 実装が方針から逸れる場合は、黙って進めず理由を明記する。
