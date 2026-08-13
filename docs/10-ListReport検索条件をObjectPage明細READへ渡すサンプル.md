# List Report検索条件をObject Page明細READへ渡すサンプル

このサンプルは、CAP JavaとUI5が別プロジェクトである前提で、List Reportの検索条件をObject Page内の関連テーブルREADへ`$filter`として渡します。

## 実装箇所

- CAPモデル: `A-cap/db/schema.cds`
- CAPサービス/アノテーション: `A-cap/srv/cat-service.cds`
- テストデータ:
  - `A-cap/db/data/fiori.study-Books.csv`
  - `A-cap/db/data/fiori.study-BookSchedules.csv`
- Javaハンドラー: `A-cap/srv/src/main/java/customer/fiori_study/BookSchedulesFilterHandler.java`
- UI5拡張登録: `A-ui5/webapp/manifest.json`
- TypeScriptコントローラー:
  - `A-ui5/webapp/ext/controller/ListReportExt.controller.ts`
  - `A-ui5/webapp/ext/controller/ObjectPageExt.controller.ts`
- TypeScriptビルド設定:
  - `A-ui5/tsconfig.json`
  - `A-ui5/ui5.yaml`
  - `A-ui5/package.json`
- Object Pageヘッダー表示Fragment:
  - `A-ui5/webapp/ext/fragment/SearchContextHeader.fragment.xml`

## 処理の流れ

1. List Reportで`availableDate`を検索条件にする。
2. 行押下時、`ListReportExt`が現在のFilterを取得する。
3. `availableDate`条件をObject Page明細用の`businessDate`条件へ変換する。
4. Object Page URL queryに`lrFilters`として載せて遷移する。
5. Object Pageの`schedules`テーブルREAD直前に`ObjectPageExt.onBeforeRebindSchedules`が呼ばれる。
6. `lrFilters`を`sap.ui.model.Filter`へ戻して`collectionBindingInfo.addFilter(...)`する。
7. CAP Javaには`BookSchedules`の通常の`$filter`として到達する。

画面表示用には`lrContext`を使います。`lrContext`にはREAD用の`filters`に加えて、Object Pageヘッダーへ表示する`summary`と検索ワード`search`を含めます。

## 確認例

List Reportで`availableDate`を`2026-08-05`以後、または`2026-08-05..2026-08-31`で検索してからObject Pageへ遷移します。

Object Pageの`schedules`明細READでは、CAP Javaログに以下のようにCQNが出ます。

```text
BookSchedules READ CQN: SELECT ... FROM CatalogService.BookSchedules ... WHERE businessDate >= 2026-08-05 ...
```

既存処理が`$filter`由来のwhere句を読んでいる場合は、この`BookSchedules`のREADでそのまま拾えます。

## 再生成

CAP JavaはCDS変更後に生成物更新が必要です。

```sh
cd A-cap
mvn clean install
```

または開発時は以下でも構いません。

```sh
cd A-cap/srv
mvn spring-boot:run
```

`csn.json`、EDMX、生成Javaなどの生成物は、CDS変更後に上記のMavenビルドで再生成してください。
これらはリポジトリへ固定保存せず、クリーンな環境でもビルド時に生成できる状態を保ちます。

UI5側はTypeScript実行のため、依存導入後に以下を確認してください。

```sh
cd A-ui5
npm install
npm run typecheck
npm run build
```
