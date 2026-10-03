# GitHub Pages デプロイ修復計画

作成日：2026年10月3日  
改訂日：2026年10月3日（差分の基準リポジトリを特定し、ロックファイル方針を改訂）  
計画担当：GPT-6 Luna  
対象：外側のプロジェクトリポジトリ `raymee675/Raymee-Kitchen`、`main` ブランチ

## 目的と期待する動作

Pages用のCSSビルドで不足している `tw-animate-css` を追加し、既存のGitHub Actionsから調理管理アプリをGitHub Pagesへ公開できるようにする。固定のスマートフォン1台で公開URLを開き、既存の端末内JavaScript版を使う構成を維持する。

## 確認済みの事実と制約

- GitHub Actions実行 `37020520133`（コミット `1f814e9fd6efc7bd104b26e6eb8f155a2ea0f1c8`）は依存関係のインストールとTypeScriptチェックを通過し、静的アプリのビルドで失敗した。記録された原因は `Unable to resolve @import "tw-animate-css"` と同モジュールを開く際の `ENOENT`。
- `cooking-app/app/globals.css` は `tw-animate-css` をインポートする。UIでは `animate-in`、`animate-out`、accordion、caret-blinkのアニメーションクラスを使うため、CSSのインポートを削除せず依存関係を追加する。
- Tailwind CSSは `4.2.1`、Viteは `8.0.13`。追加する依存は `tw-animate-css@1.4.0` とし、`package.json` で完全一致のバージョンを指定する。
- デプロイworkflow `.github/workflows/deploy-pages.yml` は `ubuntu-latest` とNode.js `24.19.0` を使い、`npm ci`、`npm run typecheck`、`npm run build:pages` の順に実行してからPages artifactをデプロイする。
- 変更の基準はワークスペース外側のプロジェクトroot（HEAD `1f814e9`）。その基準では現在 `cooking-app/package.json` に1行の追加があり、`cooking-app/package-lock.json` は8行追加・606行削除の状態である。
- `cooking-app` ディレクトリ内には別の古いGitメタデータがあり、`git -C cooking-app` はHEAD `dd7190d` の旧スターターとの巨大な差分を表示する。今回の差分確認・復元には使わず、外側のプロジェクトrootから操作する。
- 現在のnpm生成lockは新しいパッケージのroot宣言とレコードを追加する一方、34個の既存packageレコードも削除している。削除には26個の `@esbuild/*` OS/CPU別レコード（Ubuntu CIで使う `@esbuild/linux-x64` を含む）および `esbuild`、`tsx`、`terser` と関連レコードが含まれる。今回の依存追加には不要な差分であり、Linux CIへの影響を排除できないため、そのまま保持しない。
- ローカルの直接 `npm` コマンドはPATH上にない。`pnpm dlx npm@11` でnpm `11.21.0` を起動でき、依存追加コマンドは成功した。ただし、続けて開始した `pnpm dlx npm@11 ci` は完了前に中断された。`npm ci`、型チェック、Pagesビルドの成功は未確認である。
- 今回の作業では製品コード・lockfileの追加変更、検証、コミット、pushは行わない。計画のレビュー後に実装担当が続行する。

## 変更対象と担当

| 対象 | 変更内容 | 担当 |
| --- | --- | --- |
| `docs/github-pages-deployment-plan.md` | 方針・調査結果・検証条件を記載する | Luna（本計画の作成者） |
| `cooking-app/package.json` | 既に追加された `devDependencies.tw-animate-css: "1.4.0"` を保持する | 実装担当Luna worker |
| `cooking-app/package-lock.json` | 外側rootのHEADを基準に、rootのdevDependency宣言と `tw-animate-css@1.4.0` のpackageレコードだけを追加する。既存レコードは保持する | 同じ実装担当Luna worker |
| 検証と最終差分レビュー | npm ci、型チェック、Pagesビルドを実行し、差分をレビューする | Luna workerが実行、Solがレビュー |
| コミット、push、Actions、Pages公開確認 | 変更を公開し、新規workflow実行とURLを確認する | 親エージェント |

CSS、UI、アプリの保存方式、workflowは今回の修復対象に含めない。検証で別の障害が分かった場合は、ログに基づきSolが計画を改訂してから対応する。

## 実施手順

1. Solが本計画をレビューし、最小lock方針を承認する。
2. 実装担当Luna workerは外側rootのHEAD版 `cooking-app/package-lock.json` を基準にする。現行のnpm生成lockから `packages[""].devDependencies.tw-animate-css` と `packages["node_modules/tw-animate-css"]` のレコード（version、resolved、integrity、dev、license、funding）を取り込み、既存の依存レコードやoptional packageレコードは削除しない。`package.json` の完全一致指定は現行の1行を保持する。
3. 変更後、外側rootから差分を確認する。差分は `package.json` の依存追加1行と、lockのroot宣言および新規パッケージレコードに限ることを確認する。特に `@esbuild/linux-x64` と他の既存optional packageレコードが残っていることを確認する。
4. `cooking-app` で `pnpm dlx npm@11 ci` を最後まで実行し、lockから依存を再現できることを確認する。続けて `pnpm dlx npm@11 run typecheck` を実行する。
5. PowerShellで `$env:PAGES_BASE_PATH = '/Raymee-Kitchen/'` を設定し、`pnpm dlx npm@11 run build:pages` を実行する。`dist-pages` が生成されることも確認する。各コマンドの終了コードと最終差分を報告する。
6. `npm ci` が最小lockの不整合を明示して失敗した場合は、エラーを保存し、原因が `tw-animate-css` の完全なロック情報に限られるか調査する。理由が確認できるまでlock全体の再生成や無関係な削除をしない。計画にない変更が必要なら、Solが先に計画を改訂する。
7. Solが最終差分をレビューする。親エージェントが変更をコミットして `main` にpushし、その新しいコミットによるActionsのbuild、artifact upload、Pages deploy成功を確認する。
8. 親エージェントがActionsのPages URLを開き、画面とベースパス配下の静的アセット取得を確認する。スマートフォンでの全操作はユーザー端末で確認する。

## 検証と受け入れ条件

- 外側rootから見た差分は、`package.json` の `tw-animate-css: "1.4.0"` 追加と、lockの同パッケージに必要なroot宣言・packageレコードだけである。既存lockエントリは削除しない。
- lockに `tw-animate-css` のversion `1.4.0`、resolved URL、integrityがあり、既存のLinux向け `@esbuild/linux-x64` と全platform optional recordが保持される。
- `pnpm dlx npm@11 ci`、`pnpm dlx npm@11 run typecheck`、ベースパスを設定した `pnpm dlx npm@11 run build:pages` がすべて成功し、`dist-pages` が生成される。
- 新しいGitHub Actions実行（Ubuntu runner）でビルド、artifact upload、Pages deploymentが成功する。
- 公開URLでアプリが表示され、`/Raymee-Kitchen/` 配下からアセットが取得される。
- スマートフォンでの実操作は別途ユーザー端末で確認し、URL到達確認だけをもって全操作の検証済みとはしない。

## リスクと未確定事項

- Windows上のnpm lock生成でLinux向けoptional package記録が削られることがある。Ubuntu Actionsが最終的なクロスプラットフォーム検証となるため、既存platform recordsを保護し、Actionsの新規実行を必須とする。
- `npm ci` のローカル成功だけではLinuxでのesbuild optional package欠落を除外できない。lockの差分確認とUbuntu workflow成功の両方を受け入れ条件とする。
- PrivateリポジトリのPages利用可否やPages設定はアカウントの契約・設定に依存する。設定エラーが出た場合は内容を確認し、必要な変更のみを判断する。
- 他の未宣言依存があれば、今回のCSS依存を追加した後に別のビルドエラーが現れる可能性がある。ログを根拠に扱い、先回りした広範な更新はしない。
