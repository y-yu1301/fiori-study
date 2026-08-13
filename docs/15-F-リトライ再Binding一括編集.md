# F：リトライ・再Binding方式の一括編集サンプル

## 位置付け

Fは、HTTP Headerの設定タイミング問題を設計変更で解消するサンプルではありません。
現場で動作している次の方式を、比較できる独立アプリとして再現します。

1. List Reportの検索条件を`sessionStorage`へ保存する
2. Object Pageの`onBeforeBinding`で共有OData ModelのHTTP Headerを変更する
3. Modelが通信中なら短い間隔でHeader設定をリトライする
4. Header設定後にObject PageのルートContextを再読込する
5. Object Page本文Tableの`beforeRebindTable`でも同じ条件をFilterへ追加する
6. CAPではHeaderがあればHeader、なければOData Filterを使う

プロジェクトとポートは次のとおりです。

- Backend: `F-cap`（CAP Java、port 4009）
- Frontend: `F-ui5`（Fiori Elements、port 8087）

## 通信の流れ

```text
List Reportの実検索Filter
        |
        v
sessionStorage
   |                |
   |                +--> Object Page Tableの$filter
   |                         |
   +--> X-Search-Condition   |
             |               |
             +-------> CAP WorkItemsHandler
                            Headerあり: Headerを優先
                            Headerなし: $filterを維持
```

検索条件DTOは次の形です。

```json
{
  "location": "東京",
  "fromDate": "2026-08-01",
  "toDate": "2026-08-31",
  "status": "OPEN"
}
```

保存キーは`f.retry.edit.searchCondition`、HTTP Header名は
`X-Search-Condition`です。日本語を含むJSONはFrontendでURIエンコードし、CAPで
UTF-8としてデコードします。

## Frontend実装

### List Report

`F-ui5/webapp/ext/controller/ListReportExt.controller.ts`の
`onBeforeRebindWorkItems`が、検索に使われるFilterをDTOへ変換して保存します。

Filterの形はUI5の版やイベント発生箇所によって、配列、単一Filter、Condition Mapに
変わるため、変換処理を`SearchCondition.ts`へまとめています。

### Object Page開始時

`ObjectPageExt.controller.ts`の`routing.onBeforeBinding`がHeader設定を開始します。

- 試行間隔: 150ミリ秒
- 最大試行回数: 40回
- 最大待機時間の目安: 約6秒
- 新しいNavigationが始まった場合: 古いタイマーを無効化

`ODataModel.changeHttpHeaders()`が成功した後、Binding Contextの`requestRefresh()`を
呼びます。最初のルートREADがHeaderなしで先行していても、再READではHeaderから生成した
検索条件をObject Page Headerへ表示できます。

### Object Page本文Table

`onBeforeRebindBulkItems`が保存DTOから標準UI5 Filterを再生成し、Table Bindingへ追加します。
この経路は、Header設定が間に合わない場合のフォールバックです。

## CAP実装

`F-cap/srv/src/main/java/customer/f_retry_edit/WorkItemsHandler.java`にREAD処理を集約しています。

Object Page本文TableのREADでは、Navigationの選択行制約を外すため、`from`を
`WorkItemService.WorkItemBulkItems`へ置き換えます。

- Headerあり: Header DTOから`where`を作り、受信Filterより優先する
- Headerなし: 受信CQNの`where`を維持し、OData Filterで検索する

Object PageルートEntityは標準キーで取得し、After READでHeaderからvirtual項目
`searchLocation`、`searchPeriod`、`searchStatus`を設定します。

Object PageルートはDraft対応ですが、本文Tableは同じDBテーブルを非Draft投影として直接
更新します。選択行については、保存時のDraft Activateが古いルート値を上書きしないよう、
ルートUPDATE直前にActive側の最新編集値をDraft更新データへ同期します。

## 起動方法

Backend:

```sh
cd F-cap
mvn clean install
cd srv
mvn spring-boot:run
```

Frontend:

```sh
cd F-ui5
npm install
npm run typecheck
npm start
```

ブラウザで`http://localhost:8087`を開き、次の条件で検索します。

- 場所: 東京
- 日付: 2026/08/01～2026/08/31
- ステータス: OPEN

List Reportには「東京作業 001」から「東京作業 005」までの5件が表示されます。
行からObject Pageへ遷移すると、Headerに検索条件、本文Tableに同じ5件を表示します。

ローカルの直接起動にはABAP LREPなどのFlex保存サービスがないため、`index.html`では
`LocalStorageConnector`を指定しています。Object Page Tableのソート・列・Filter設定は
ブラウザのLocal Storageへ保存され、存在しない`/sap/bc/lrep`へは保存しません。
実環境へ配置する場合は、配置先が提供するFlexibility Service設定を使用してください。

ブラウザコンソールでは、タイミングに応じて次のログを確認できます。

```text
[f-retry-edit] ODataModel is busy; retry Header setup (...)
[f-retry-edit] Header setup succeeded on attempt ...
[f-retry-edit] Added stored condition to Object Page table Filter.
```

CAPログでは本文Tableがどちらの経路を採用したか確認できます。

```text
WorkItemBulkItems READ source=HEADER ...
WorkItemBulkItems READ source=ODATA_FILTER
```

## 意図的に残している課題

- 同じ条件をHTTP HeaderとOData Filterの二経路で送る
- Header変更がOData Modelのアイドルタイミングに依存する
- 最初のREADとrefresh後のREADで通信が重複する
- Header変更に失敗し続けると、画面上部の検索条件が表示されない
- `sessionStorage`の単一キーなので、複数検索結果を同時保持できない
- 同じ条件を再検索する方式のため、List Report表示後にDBが変わると結果集合も変わる

これらは不具合の見落としではなく、Fが再現対象とする方式そのものの制約です。
FはEの代替設計ではなく、既存方式を比較・説明するための独立した動作サンプルです。
