# 操作取り消しと盤外ドラッグの計画

更新日：2026年10月4日

## 目的・期待動作

盤外へ楕円をドラッグして離しても削除しない。鉄板外および鉄板間の隙間へのリリースはキャンセルとして扱い、ドラッグプレビューを消して楕円を保存済みの元の鉄板・位置に残す。赤い楕円でも盤外破棄の実行記録を新規作成しない。盤外キャンセルではコマンドを送らず、revision・version・undoHistoryも変更しない。

有効な鉄板上への移動は継続し、移動・新規配置は既存の「操作を取り消す」機能で取り消せる。重なる位置への移動拒否も維持する。盤外削除のcue、説明、toast、WebMCPコマンドを利用者向け経路から取り除く。

## コード調査で確認した現状

- `cooking-app/app/kitchen.tsx` のpointer-upは有効なdropTargetがないと `delete` commandを送る。ドラッグ中は `deleteCue` を表示し、ヘルプにも盤外削除を案内する。
- `cooking-app/lib/kitchen-model.ts` は `delete` commandで楕円を除き、赤い楕円なら盤外破棄recordを作る。またUndoEntryのdelete型とundo復元処理がある。
- `operate_kitchen` の説明とtype enumが `delete` を公開している。READMEも盤外削除とその取り消しを記載している。
- PCはSQLite内の正規化済みボードJSON、PagesはlocalStorage schemaVersion 5に `undoHistory` を保持する。既存の盤外破棄recordと保存済みdelete UndoEntryはデータ互換上保持する必要がある。

## 互換性・保存データ方針

- 新しいUI、WebMCP、通常Command経路から盤外 `delete` を除き、盤外releaseでサーバー/ローカル保存へ要求しない。
- 旧PCタブなどから届くdelete commandは、状態を一切変更せず「盤外削除は廃止されました。画面を再読み込みしてください」と明示的に拒否する。他commandのAPI契約は維持する。旧画面にもdeleteを許すと今回の削除廃止を保証できないため、このcommandに限り拒否を優先する。
- 既存のUndoEntry `type: "delete"` の読込・検証・復元分岐を残す。過去のundoHistory先頭にdelete entryがあれば従来どおり復元可能にし、新規entryは作らない。
- 過去のExecutionRecord、盤外破棄記録、CSV内容は改変・削除しない。保存形式は変更しないためPages schemaVersion、SQLite envelopeの移行は不要。盤外releaseのキャンセルでは古い履歴を積み下ろししない。

## 影響ファイル・実装担当

**GPT-6 Luna実装worker**（以下の担当範囲。既存の未コミット変更は保持）：

1. `cooking-app/app/kitchen.tsx`：盤外pointer-upではpreviewを消すだけにし、delete requestを送らない。delete cue/state・削除toastと、ヘルプ中の盤外削除説明を取り除く。WebMCP説明とschemaからdeleteを除き、undoを配置・移動の取り消しとして説明する。
2. `cooking-app/lib/kitchen-model.ts`：通常Command型・parserからdeleteを除き、旧delete requestは副作用なしの明確なエラーにする。新規盤外破棄record生成経路をなくす。保存済みUndoEntryのdelete型・正規化検証・undo復元と、既存recordの扱いは維持する。
3. `cooking-app/README.md`：盤外releaseはキャンセルされ元位置へ戻ると説明し、盤外削除と盤外破棄の操作案内を除く。Undo説明は新規配置・移動の取り消しに合わせる。
4. `cooking-app/server/storage.mjs`、`cooking-app/server/restore.mjs`、`cooking-app/lib/local-kitchen-storage.ts`：保存形式変更や移行を加えない。旧UndoEntryと過去recordのread/write/validationが保たれるか確認し、必要な互換修正だけ行う。
5. **Sol coordinator**：差分を統合確認し、温度・90秒/30分タイマー・ID採番・既存record・配置/移動Undoの未コミット実装を保全する。
6. **別のGPT-6 Luna reviewer**：実装者と分けて、盤外cancel、legacy command拒否の無副作用、保存済みdelete UndoEntry互換、配置/移動Undoの維持を確認する。

## 実装手順

1. pointer-upの盤外分岐をcancelに変更し、移動preview/cueの状態を整理する。
2. モデルと公開schemaから通常delete経路を除き、legacy requestを副作用なしで拒否する。UndoEntryの旧delete互換処理は維持する。
3. ヘルプ、toast、WebMCP説明/schema、READMEの盤外削除案内を更新する。
4. 保存形式と既存履歴・recordへの影響を差分レビューし、独立レビューを受ける。

## 検証・受け入れ条件

- 待機中・計測中・赤い楕円を鉄板外または隙間で離しても、元の場所に残り、新規record・revision・version・undoHistory変化がない。赤い状態でも盤外破棄recordを作らない。
- 有効場所への移動、重なり拒否、新規配置/移動のUndoが従来どおり機能する。盤外キャンセルはUndo履歴を追加・消費しない。
- UI、ヘルプ、README、WebMCPの説明/schemaから盤外削除の利用案内とdelete操作がなくなる。
- 旧delete requestは明確に拒否され、items・records・revision・undoHistoryを変更しない。他の旧commandは維持する。
- 保存済み盤外破棄recordは再読込とCSV出力後も残る。既存のdelete UndoEntryを読み込み、Undoで楕円とそのentryに関連する破棄recordのみを復元できる。
- 実装後に差分レビュー、`git diff --check`、TypeScript型確認、PC/Pagesビルド、サーバー変更時の構文確認を行う。依頼されていないためテストは追加・実行しない。

## リスク

- 削除動作を含む旧PCタブは盤外releaseが明示エラーになるため再読み込みが必要。他のcommandは互換とする。
- 過去版が残したdelete UndoEntryは新規操作では作られないが、履歴先頭に残っていれば取り消し可能である。これは保存互換のための経路であり、盤外削除の再導入ではない。
- 既存の「調理操作後にundoHistoryを消去する」境界は維持する。キャンセルrelease自体は操作でないため、その境界にも触れない。

## 現在の実装状況

盤外リリースをキャンセル扱いに変更し、保存コマンドを送らず楕円を元位置に戻す。盤外削除cue・案内・WebMCP操作を除き、旧delete requestは副作用なしで拒否する。新しいUndo履歴は配置・移動だけを積む。保存済みdelete UndoEntryと過去の盤外破棄recordの読込・Undo・CSV互換は維持する。

検証：TypeScript型確認、PC版・Pages版ビルド、`git diff --check` は成功。独立コードレビューで主要経路に指摘なし。テストは依頼されていないため追加・実行していない。作業ツリーには直前の配置順ID・操作Undoの未コミット変更も含む。今回の変更はコミット・プッシュ・公開をしていない。
