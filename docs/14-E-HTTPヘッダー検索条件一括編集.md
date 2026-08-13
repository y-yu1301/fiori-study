# E：HTTPヘッダーを検索条件の正とする一括編集サンプル

## 目的

Eは、今回の要件だけから独立して作成した最小サンプルです。

- List Reportの検索条件を`sessionStorage`へ保存する
- Object Page開始前に`X-Search-Condition`へ設定する
- Object Page Headerと本文Tableが同じHeaderを使う
- Headerがあるとき、CAPはHeaderだけから業務WHEREを生成する
- Headerがないときは通常のOData Filter処理を使う
- SearchContext用のDB Entityは作らない
- 行クリックによるFiori Elements標準Navigationを維持する

プロジェクトは次の2つです。

- Backend: `E-cap`（CAP Java、port 4008）
- Frontend: `E-ui5`（Fiori Elements、port 8086）

## 検索条件DTO

`sessionStorage`とHTTP Headerでは、次の同じDTOを使います。

```json
{
  "location": "東京",
  "fromDate": "2026-08-01",
  "toDate": "2026-08-31",
  "status": "OPEN"
}
```

保存キーは`e.header.edit.searchCondition`です。

ブラウザのHTTP Headerは日本語をそのまま安全に送れないため、実際のHeader値は
`encodeURIComponent(JSON.stringify(condition))`でエンコードします。CAP側はUTF-8で
デコードしてからJSON Parseします。JSONの構造自体は上記のままです。

## Frontendの流れ

実装の入口は次の2ファイルです。

- `E-ui5/webapp/ext/controller/ListReportExt.controller.ts`
- `E-ui5/webapp/ext/controller/ObjectPageExt.controller.ts`

List Reportの`beforeRebindTable`で、そのREADに実際に使われる場所・日付・ステータスを
単純なDTOへ変換して保存します。この時点ではOData ModelのカスタムHeaderを削除するため、
List Reportの検索自体は標準のOData Filterだけで実行されます。

行クリック時は`onBeforeNavigation`でHeaderを設定し、`false`を返して標準Navigationを
そのまま続行します。Object Page側の`routing.onBeforeBinding`でも同じ設定を1回行います。
タイマー、再試行、強制再Bindingはありません。

Object Page本文テーブルへList Report条件を`$filter`として再注入していません。
業務検索条件の経路は次の1本です。

```text
List Report condition
  -> sessionStorage
  -> X-Search-Condition
  -> CAP SearchCondition
  -> CQN where
```

## CAPの流れ

実装の入口は次のファイルです。

- `E-cap/srv/src/main/java/customer/e_header_edit/WorkItemsHandler.java`

`readSearchCondition`がHeader取得とJSON Parseを担当し、`createWhere`がHeader DTOから
CQNの`where`配列を生成します。条件判定とWHERE生成を他のHandlerへ分散させていません。

Object Page本文の`WorkItemBulkItems` READでは次のように動きます。

1. Headerがなければ、受信CQNをそのまま通常処理する
2. Headerがあれば、Navigation由来の`from`を本文用Entity Setへ置き換える
3. 業務`where`をHeaderから作り直す
4. 元CQNのcolumns、orderBy、limitなどは維持する
5. `$count`対応のため`inlineCount()`付きで実行する

Object Pageルートの`WorkItems` READは選択行のキーを変えません。After READで同じHeaderから
`searchLocation`、`searchPeriod`、`searchStatus`というvirtual項目を生成し、Header Facetへ
表示します。これらはDB列ではありません。

DB Entityは業務データの`WorkItems`だけです。本文テーブル用の`WorkItemBulkItems`は同じ
Entityのサービス投影であり、新しいDBテーブルではありません。

## 動作確認

Backend:

```sh
cd E-cap
mvn clean install
cd srv
mvn spring-boot:run
```

Frontend:

```sh
cd E-ui5
npm install
npm run typecheck
npm start
```

ブラウザで`http://localhost:8086`を開き、次の条件で検索します。

- 場所: 東京
- 日付: 2026/08/01～2026/08/31
- ステータス: OPEN

List Reportには「東京作業 001」から「東京作業 005」までの5件が表示されます。
いずれかの行からObject Pageへ標準遷移すると、Headerには同じ条件、本文テーブルには
同じ5件が表示されます。Object Pageの編集モードでは本文テーブルの複数行を変更できます。

## サンプルの範囲

要件に合わせ、単一の場所、単一のステータス、1つの日付範囲だけを対象にしています。
複数値・OR・任意項目を扱う汎用Filter AST、SearchContext ID、永続化、複数検索結果の同時保持は
このサンプルには含めていません。
