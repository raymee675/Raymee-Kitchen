# 配置Undo時のID再利用 計画

作成日：2026年10月4日　｜　状態：実装・独立再レビュー済み。型確認・PC/Pagesビルド・diff-check成功。テスト未実行。

## 目的・期待動作

配置をUndoすると、その配置で割り当てた連番IDを条件付きで採番カウンターへ戻し、次の配置で再利用する。移動Undoは位置のみを戻し、IDとカウンターは変えない。

再利用条件は、Undo対象のcreate IDがM-N形式で、pancakeOrdinalForId(id) === nextPancakeOrdinal - 1 を満たし、Undo後に同じIDの調理中楕円・完成ボックス・実行記録が残らないこと。古いUUID履歴、最新ではないID、参照が残る状態ではカウンターを下げない。UUIDから序数を推測しない。

成功した配置Undoは盤面generationを1進める。ID解放とgeneration更新を同じモデル遷移で行い、PC版の既存SQLiteトランザクションとPages版の既存直列保存で原子的に保持する。generationがNumber.MAX_SAFE_INTEGERなら、配置Undo全体を副作用なしで拒否する。既存のoperationId冪等性とgeneration conflict後の再同期を維持する。

## 現状・制約

- cooking-app/lib/kitchen-model.ts のcreateはnextPancakeOrdinalを進める。現在のUndoEntry.type === createは楕円と履歴を削除するだけで、カウンター/generationを変更しない。pancakeOrdinalForIdはUUIDにnullを返し、normalizeBoardDataはカウンターが保存済みのライブ項目・完成項目・実行記録IDを越えることを検証する。
- PCのserver/storage.mjsはモデル結果、revision、operation receipt、generationとカウンターを含むstateを同一SQLiteトランザクションで保存する。Pagesはuse-kitchen-local.tsのmutation queueで共通モデル結果を保存する。保存形式、API、DBスキーマの変更は不要の見込み。
- PCのuse-kitchen.tsは非401応答エラー後に同期を呼び、Pagesはモデルを同一経路で使う。generation conflict後に最新Snapshotを受け入れる既存挙動を維持する。
- 独立レビューで、ポインター押下中に別端末がUndoと再配置を行った場合、Contactが旧ID/versionを保持したままpointer-up時にuse-kitchen.tsが現在generationを補完する競合を発見した。WebMCP operate_kitchenもgenerationをスキーマで要求しないため、古いread_kitchen結果に対する操作へ現在generationを補完する経路がある。
- cooking-app/README.mdとdocs/plate-grid-layout-plan.mdに「Undo後もIDを再利用しない」とあるため、新しい条件付きルールに更新する。

## 影響ファイル・担当

**GPT-6 Luna実装worker**（productionと文書の差分を担当）：

1. cooking-app/lib/kitchen-model.ts：配置Undo分岐で残存参照、直近採番ID、generation上限を検証する。安全な場合に限りnextPancakeOrdinalをID序数へ戻しgenerationを進める。拒否時はitems・履歴・カウンター・generationを一切変更しない。移動Undoには影響させない。（実装済み）
2. cooking-app/app/kitchen.tsx：Contactにpointerdown時のgenerationを保存する。generation変更時は進行中のgestureとpreviewをキャンセルし、pointer-up由来のcreate/start/adjust/remove/moveにはContactのexpectedGenerationを渡す。WebMCP operate_kitchen schemaはexpectedGenerationを必須とし、古い取得結果の操作を現在値で補完せず拒否する。操作結果にもgenerationを含める。
3. cooking-app/README.md、docs/plate-grid-layout-plan.md、docs/oval-sequential-id-plan.md：配置Undo後の直後再利用、再利用条件、移動Undoと例外時の扱いを記載する。（READMEと2計画は更新済み）

**GPT-6 Luna UI実装worker**（追加対応）：`cooking-app/app/kitchen.tsx` のpointer Contact・ジェスチャー・WebMCP世代契約だけを担当し、既存差分を維持する。**Sol coordinator**：この計画改訂と統合確認を担当する。**別のGPT-6 Luna reviewer**：実装者と分け、初回指摘に加えて修正後のpointer/WebMCP stale command拒否、カウンター境界、世代競合を再レビューする。storage/hookの保存・同期既存経路を利用し、追加変更の必要性をレビューで判断する。

## 実装手順

1. 共通モデルで実装済みの配置Undoは、最新M-Nだけカウンターを戻し、create Undoごとにgenerationを上げる。UUID/非最新IDではカウンターを保ち、generation上限時は副作用なしで拒否する。
2. Contactの世代捕捉とgeneration変更時のgesture cancelを追加し、pointer-up由来コマンドに取得世代を明示する。
3. WebMCP schemaでexpectedGenerationを必須にし、結果へgenerationを含める。古いread_kitchen後の呼び出しが最新generationへ暗黙補完されないことを確認する。
4. PC SQLite transaction、Pages localStorage直列保存、PC conflict後syncの既存経路で世代・カウンターが保持されることを確認し、別担当に修正差分を再レビューしてもらう。

## 受け入れ条件・検証

- 初期状態で1-1を配置してUndoした直後、新規配置が1-1。後続IDがある場合、最新配置だけが番号を戻す。
- 最新でないID/UUIDではカウンターを下げない。参照が残る不整合やgeneration上限ではUndoは副作用なし。移動UndoはID・カウンター・generationを維持する。
- 同一Undo operationIdの再送でカウンター/generationを二度更新しない。PCでは古いgenerationの操作を拒否して新Snapshotへ同期し、Pagesでは同じlocalStorage stateへ直列保存する。
- 別PCがpointerdown保持中にcreate Undo→同ID再配置をしたとき、古いContactは世代変更時にcancelされるか、旧expectedGenerationで拒否され、新しい楕円へ操作を適用しない。
- WebMCP operate_kitchenはexpectedGenerationを必須入力とし、古いread_kitchen世代による操作を拒否する。operation responseにgenerationが含まれ、次の呼び出しで新世代を指定できる。
- TypeScript型確認、PC版/Pages版ビルド、git diff --check、差分レビューを実施する。ユーザー依頼がないためテストは追加・実行しない。

## リスク

再利用は直近に割り当てたIDの配置Undoに限定する。過去記録とのID誤結合を防ぐため、記録を含む残存参照が一つでもあれば再利用しない。generationを進める配置Undo後は、Undo前の世代に基づくPC画面の未送信コマンドも拒否され、再同期が必要になる。
