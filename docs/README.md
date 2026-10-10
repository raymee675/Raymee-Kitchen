# ドキュメント索引

更新日：2026-10-10

この一覧は各資料の役割と入口を示します。現行の運用・サポート範囲を決める資料は[固定1台のスマートフォンで使うGitHub Pages構成](single-phone-github-pages-architecture.md)だけです。個別機能の計画・実装記録は、その機能の要件や記録日当時の状態を示すもので、ホスティング方式や運用手順を変更しません。各計画の進捗・未決事項は、それぞれの資料内の記載を参照してください。

## 現行運用と利用者向け案内

- [固定1台のスマートフォンで使うGitHub Pages構成](single-phone-github-pages-architecture.md) — **現行運用・サポート範囲の正本**。保存、オフライン条件、公開範囲、データ消失条件、Pages公開記録、実機確認状況を記載します。
- [アプリREADME](../cooking-app/README.md) — 利用者向け導入・操作案内と、Pages版の開発手順。

## 現行の機能計画と公開記録

- [生地タイマー計画](dough-timer-plan.md) — 生地タイマー機能の要件・未決事項・作業計画。記載された機能の範囲と進捗を示します。運用基盤は上記の正本に従います。
- [GitHub Pagesデプロイ修復計画・記録](github-pages-deployment-plan.md) — 2026-10-03時点のデプロイ成功、HTTP 200、画面内エラーの履歴です。その後の公開記録と確認状況は現行構成の正本に記載します。
- [Pages版ドキュメント統合計画・実施記録](pages-documentation-consolidation-plan.md) — 今回の文書整理の方針、作業範囲と完了内容。
- [Pages版の使いやすさ改善計画](pages-single-phone-usability-plan.md) — 2026-10-08時点の実装計画。後日追加されたJSONバックアップ等の最新状況は本索引と現行構成正本を参照してください。

## 個別機能の計画・実装記録

以下は個別機能の設計・実装状況を扱います。各ファイルにある状態表示はその資料の記録であり、アプリ全体の現行運用状況を表しません。

- [完成ボックス計画](completed-box-plan.md)
- [実行記録の書き出し計画](execution-record-export-plan.md)
- [実行記録CSVを1 ID 1行にする計画](execution-record-one-row-plan.md)
- [鉄板配置グリッド計画](plate-grid-layout-plan.md)
- [楕円ラベルの読みやすさ計画](oval-label-readability-plan.md)
- [下段限定の新規配置計画](oval-lower-row-placement-plan.md)
- [待機中楕円の上段移動計画](blank-pancake-tap-move-plan.md)
- [楕円の移動計画](oval-move-plan.md)
- [楕円IDの配置順採番計画](oval-sequential-id-plan.md)
- [上向き移動制限計画](oval-upward-only-movement-plan.md)
- [長押し移動の削除計画](remove-longpress-movement-plan.md)
- [リセット機能計画](reset-cache-plan.md)
- [調理中のお好み焼きのタップ移動計画](running-pancake-tap-move-plan.md)
- [温度・固定90秒・横画面対応計画](temperature-and-landscape-plan.md)
- [操作取り消しと盤外操作の計画](undo-action-plan.md)
- [配置Undo時のID再利用計画](undo-id-reuse-plan.md)

## 過去の構成案・検証記録

これらは当時の構想、判断、検証結果を保持する履歴資料です。現在の運用・サポート手順として使わず、現行構成は[正本](single-phone-github-pages-architecture.md)を参照してください。

- [初期の食品調理管理システム実装計画](implementation-plan.md) — Site版を含む初期構想。
- [アカウント共有を不要にする運用方式の検討](hosting-options.md) — SiteからPCやクラウドへ移行する案。
- [クラウド構成の検討](cloud-architecture.md) — Cloudflareを使う過去の設計案。
- [PC・モバイル回線向け実装計画](pc-mobile-implementation-plan.md) — PCサーバーと複数スマートフォンを前提にした履歴。
- [Site版の実装・検証記録](verification.md) — 2026-09-27時点のSite版に限る検証結果。
- [GitHub PagesでPCサーバーを置き換える案の評価](github-pages-replacement-assessment.md) — 複数端末共有・認証を前提にした旧評価。
- [接続案内・登録コード送信の設計案](connection-delivery-architecture.md) — 固定1台・認証なしの前提に変わる前の不採用案。
- [スマートフォン向け鉄板切替UI計画](mobile-single-griddle-plan.md) — 2026-10-10に撤回された案。現在は2枚の鉄板を同じ画面に表示します。

## その他のMarkdown資料

- [shadcn Tailwind vendor license](../cooking-app/vendor/shadcn-tailwind-4.13.0.LICENSE.md) — vendored dependencyに付属するライセンス情報。製品仕様・運用手順ではありません。
