# お好み焼きIDの配置順採番 計画

作成日：2026年10月4日　｜　状態：実装・差分レビュー・静的検証済み（テスト未実行）

## 目的・期待動作

楕円を新しく配置した順に、お好み焼きIDを `1-1` から `8-24` まで採番し、調理画面と実行記録で同じIDを使う。順番は行優先とし、`1-1, 1-2, …, 1-24, 2-1, …, 8-24` とする。1ボードにつき最大192個のIDを一度ずつ割り当てる。

- IDのMは1〜8、Nは1〜24。ID文字列は `M-N` と表示する。
- IDは楕円を作成して保存する時に採番する。タイマー開始、温度変更、鉄板間移動、完成ボックス移動、提供結果の変更ではIDを変えない。
- PC版ではサーバーが作成操作を受け付けた順、Pages版では端末内の直列化された保存操作順を配置順とする。ブラウザーが採番候補を作るのではなく、保存側で採番して同時作成の重複を防ぐ。
- 一度使った番号は、未開始楕円の盤外削除を含め、再利用しない。192個を使い切った後は新規配置を拒否し、利用者に上限到達を表示する。完了記録CSVで同じIDを別のお好み焼きに再利用しないためである。
- operationIdはAPIの冪等性・コマンド識別用UUIDとして維持する。お好み焼きIDとコマンドIDを混同しない。
- 固定90秒、温度、ドラッグ削除、完成ボックスの30分タイマー、提供結果・CSV列の意味は変更しない。

## 現行実装と制約

- `cooking-app/app/kitchen.tsx` の空き場所タップが `createUuid()` で楕円IDとoperationIdの両方を生成し、`create`コマンドとして送っている。画面と完成ボックスはUUIDを18文字で分割して描画する。WebMCP `operate_kitchen` も新規IDを必須として説明している。
- `cooking-app/lib/kitchen-model.ts` が共有Command/Snapshot、`parseCommand`、ID重複確認、`applySnapshotCommand`を持つ。現状はoperationIdと楕円IDのどちらもUUID v4に限定され、Snapshotは `items`・`records`・`completionItems` を持つ。
- PC版は `cooking-app/server/storage.mjs` の `BEGIN IMMEDIATE` 内でコマンドを適用し、SQLite `boards.state` を更新する。旧配列はサーバー起動時にJSON envelopeへ移行される。従って採番カウンターもこのstateへ置けば、複数端末からの作成をDBトランザクションで直列化できる。
- Pages版は `cooking-app/lib/local-kitchen-storage.ts` のlocalStorage schemaVersion 3と `cooking-app/lib/use-kitchen-local.ts` のWeb Locks（単一編集タブ）・mutationQueueを使う。PC版とは保存領域を共有しないため、各環境で別々に `1-1` から採番する。
- `cooking-app/server/restore.mjs` のバックアップ検証とPagesの `validItem` もUUID形式を前提にしている。実行記録のCSVはIDをそのまま出すので、履歴との識別性を維持する必要がある。
- 既存UUIDには配置時刻や採番順がなく、実行記録は回収順に追加される。現在のitems配列と完成ボックス配列は、それぞれ配置順全体を表さない。過去の削除済み未開始楕円のIDも保存されていないため、旧データの完全な配置順は復元できない。

## 既存データの移行方針

旧UUIDを持つ現行データは、閲覧中の楕円が新しい形式になるよう一度だけ移行する。ただし、失われた配置履歴を推定して「当時の正確な順番」とは扱わない。

1. 旧 `items` の配列順に鉄板上の楕円へ連番を割り当てる。
2. 続けて旧 `completionItems` の配列順に完成ボックス内の楕円へ連番を割り当て、対応する未確定ExecutionRecordのIDも同じ値に変更する。
3. 既に完了した過去のExecutionRecord（提供済み、提供不可、または旧形式の判定不可）にあるUUIDはそのまま保持する。過去CSVのIDを後から変更せず、過去記録と新規IDが衝突しないようにする。
4. 連番カウンターは移行した楕円数の次から始める。移行後の保存形式にも高水位カウンターを永続化し、盤面から消えたIDを復活させない。
5. 旧PC SQLite envelopeとPages schemaVersion 1〜3を保全しながら新形式へ移行する。PagesのlocalStorageキーは変更しない。

itemsとcompletionItemsをまたいだ旧楕円の本来の配置順、および消去済み楕円の番号は判定できない。この移行順は再現可能な固定ルールであり、旧UUIDと対応する実行記録との関連は保つ。現行ライブ楕円が192個を超えていて新IDへ一意に移行できない場合は、データを部分変更せず、安全な移行方法を選べるようエラーを表示する。通常の新規作成では、上限到達時に操作を拒否する。

## 影響範囲・実装担当

**GPT-6 Luna実装worker（単独でデータ形式・採番経路を担当）**：

1. `cooking-app/lib/kitchen-model.ts`：お好み焼きIDの形式検証・採番関数、Snapshotの永続カウンター、`create` commandの契約を更新する。createではクライアント提供IDを採番に使わず、検証・重なり確認後に保存側カウンターから次IDを割り当てる。旧PCクライアントの冪等性ハッシュとの互換のため、旧createが送るUUID候補は検証してCommandに保持するが、採番には使わない。操作対象IDは移行前UUIDと新M-Nの両方を読めるようにし、operationIdは引き続きUUIDのみとする。上限時の明確な `KitchenError` を追加する。
2. `cooking-app/server/storage.mjs`：起動時の旧state移行、SQLite envelopeへのカウンター保存、スナップショット返却を更新する。作成時の割り当ては既存 `BEGIN IMMEDIATE` 内で行い、同時操作・operationId再送でも重複採番や二重作成が起きないようにする。
3. `cooking-app/lib/local-kitchen-storage.ts`、`cooking-app/lib/use-kitchen-local.ts`：schemaVersion 4へ移行し、旧盤面・完成ボックス・関連記録を一貫してリマップしてカウンターを保存する。`mutationQueue`とWeb Locksの既存排他方針を維持する。localStorageのキーは維持する。
4. `cooking-app/server/restore.mjs`：旧UUID形式のバックアップと新M-N形式・カウンター付きstateの双方を検証し、データを失わず復元できるようにする。新M-N IDを含むstateでカウンターが欠落している場合は、削除済み番号を再利用し得るため拒否する。
5. `cooking-app/lib/use-kitchen.ts`：PC版のpending操作追跡がコマンドの楕円IDを前提にしているため、createでIDが未確定でも安全に扱えるよう、operationIdなどを使ったpending keyに限定して更新する。
6. `cooking-app/app/kitchen.tsx`：空き場所タップではUUIDを楕円IDとして生成しない。楕円・完成ボックスに `M-N` を分割せず表示し、WebMCPのcreate入力説明を更新する。operationId用 `createUuid()` は維持する。作成上限エラーを利用者が理解できる表示にする。
7. `cooking-app/lib/execution-record-export.ts`：ExcelでIDの`M-N`が日付へ自動変換されないよう、CSVのIDセルを文字列として開ける形式で出力する。ID値と既存列は維持する。
8. `cooking-app/lib/kitchen-model.ts` の互換adapter `applyCommand`：旧UUID項目を連番移行した後も、旧UUIDを使う既存呼び出しを正しい楕円へ対応づける。戻り値のitemsも旧UUIDに逆写像し、複数回呼び出す既存コードのID契約を保つ。
9. `cooking-app/README.md`：採番順、PC版とPages版で保存領域が別であること、192件の上限と再利用しない方針、旧データ移行の限界を説明する。実行記録の既存列は変更しない。
10. `cooking-app/tests/pc.integration.mjs`：既存のcreate統合シナリオがUUID候補を最終IDと誤認しているため、既存楕円の移行分の次番号を期待するようアサーションを整える。テストケース追加と実行はしない。

**Sol coordinator**：採番・データ契約・移行互換性を確認し、実装workerの結果を統合する。

**独立レビュー**：実装者とは別のGPT-6 Luna reviewerが、同時作成、カウンターの永続化、完了記録とIDの参照整合、旧データ/バックアップ移行を確認する。

## 受け入れ条件・検証

- 新規配置が `1-1` から始まり、24個目が `1-24`、25個目が `2-1`、192個目が `8-24` になる。形式外（例 `0-1`, `1-25`, `9-1`）のIDは受け入れない。
- 複数PCクライアントから同時に作成しても、SQLiteに保存された操作順の連番となり、同じIDが割り当てられない。失敗した作成（重なり等）は番号を消費しない。再送された同じoperationIdは新規番号を二重に消費しない。
- Pagesでは保存された順に連番となる。画面更新後もカウンターを維持し、未開始楕円の削除後もその番号を再利用しない。
- 楕円を配置した後の開始、温度変更、移動、完成ボックスへの移動、提供・提供不可記録、CSV出力でも同じIDを保持する。CSV内で過去UUIDと新M-Nが別のお好み焼きを誤って同一化しない。
- 旧SQLite stateおよびPages schema 1〜3から、位置、温度、タイマー、完成ボックス状態、記録を失わず移行できる。現在の表示中楕円は計画に定めた決定的ルールでM-Nになり、完了済み履歴のUUIDは維持される。
- バックアップ検証は旧形式と新形式を受け入れ、新形式のカウンターを保持する。不正なカウンター、範囲外ID、重複IDを拒否する。
- 新M-N IDを含む保存形式でカウンターが欠落しているバックアップを拒否する。旧UUID形式のカウンターなしデータは移行対象として受け入れる。
- Excelで開いたCSVでもID列が`M-N`文字列として保たれる。
- 完成ボックス期限、提供状態、温度別加熱秒数、タイマー90秒は従来仕様どおりである。
- 実装後は差分レビュー、`git diff --check`、`npm run typecheck`、`npm run build:pc`、`npm run build:pages`、`node --check server/storage.mjs`、`node --check server/restore.mjs` を行う。ユーザーから実行依頼がないため、テストは追加・実行しない。利用可能ならブラウザーで新規採番、再読み込み後の継続、完成ボックスとCSVを確認する。

## リスク・未確定事項

- 既存UUIDの完全な配置順は復元不能である。計画ではライブ楕円だけ決定的に移行し、閉じた履歴はUUIDのまま残す。ユーザーが過去の全履歴IDまでM-Nへ変換したい場合、配置順を捏造せず「履歴の旧ID維持」か「別ルールでの再採番」を選ぶ必要がある。
- M-N空間は192個で有限である。IDをCSV履歴と照合するため、現計画は永久再利用せず、使い切ったら新規配置を拒否する。運用上192個を超える可能性がある場合は、将来のリセット単位（営業日・ボードなど）を別途決める必要がある。
- PC版とPages版は別々の保存領域なので、両方で同じM-Nが現れ得る。同一店舗の記録を両方から集約する運用を始める場合、CSVに環境識別子を追加するなど別の識別設計が必要だが、今回の既存CSV列・ID仕様には追加しない。
- 旧クライアントが新サーバーへUUID付きcreateを送る移行期間に備え、パーサーで従来のUUID `id` を受け取って無視する互換策を推奨する。新クライアントは作成IDを要求せず、返却Snapshotから採番済みIDを読む。
