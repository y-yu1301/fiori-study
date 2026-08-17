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

> メソッド単位の呼び出し順・データの形の変遷・各フェーズの注意点は
> [`16-F-処理フローとデータの流れ.md`](16-F-処理フローとデータの流れ.md) にまとめてあります。

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

## デバッグ手順（どの時点で何の値が入っているかを見る）

検索条件は「画面 → sessionStorage → HTTP Header / $filter → CAP」と形を変えながら流れます。
どこで壊れたかを切り分けられるよう、**加工前と加工後を両方**出すようにしてあります。

### Frontend（ブラウザのコンソール）

詳細ログは既定でオフです。開発者ツールのコンソールで次を実行して有効化します。

```js
sessionStorage.setItem("f.retry.edit.debug", "1"); location.reload();
```

コンソールのフィルタ欄に `[f-retry-edit]` を入れると、この一連の出力だけが残ります。
出力は実行順に番号が付いています。

| ログの見出し | 見えるもの | 確認したいこと |
|---|---|---|
| `①LR beforeRebindTable` 加工前 | `event.bindingParams` / `api.getFilters()` の生の値、Filter を展開したもの | 画面の条件がどんな形で来ているか（項目名・演算子・Date型かどうか） |
| `　└ applyFilter` | 1条件ずつの `oValue1 / oValue2` と変換後 | 拾えた条件・**無視した条件**（`★無視した条件` が出たらそれが原因） |
| `　└ readSearchCondition` | どの経路（event / getFilters / Condition Map）で取れたか | イベントの形が想定と違っていないか |
| `①LR beforeRebindTable` 加工後 | 保存するDTO | 期待した4項目が入っているか |
| `③OP onBeforeBinding` | 開く Context のパス、**この時点でモデルにある値** | ここで `searchLocation` に値があれば、それは一覧から引き継いだ**古い**値 |
| `③OP header (試行n)` | DTO と、ヘッダーへ載せる文字列 | 何回目の試行で成功したか。エンコード結果 |
| `③OP header` 設定後 | Model のリクエストヘッダー | キー名・値が狙いどおりか |
| `③OP header` refresh前 / refresh後 | ヘッダー側の3項目 | **古い値が残っているのか、届いていないのか**の切り分け |
| `④OP 明細 beforeRebindTable` 追加前／追加後 | `bindingParams.filters` | 自分が足した条件と FE が足した条件の区別 |

`refresh前 / refresh後` の読み方が要点です。

| refresh前 | refresh後 | 意味 |
|---|---|---|
| 値あり | 同じ値 | 前回条件のキャッシュ（＝古いデータ）。再READが起きていない |
| 空 | 値あり | 正常。初回READがヘッダー無しで先行しただけ |
| 空 | 空 | CAP側でヘッダーを読めていない → 次のCAPログを確認 |

ネットワークタブで実リクエストも確認できます（Filter に `bulkEditItems` と入力 → Request URL の `$filter`、Request Headers の `X-Search-Condition`）。

### CAP（サーバのログ）

`application.yaml` で `customer.f_retry_edit: DEBUG` にしてあります。目印は `[F-DEBUG]` です。

```sh
cd F-cap/srv && mvn spring-boot:run | grep F-DEBUG
```

| ログ | 見えるもの |
|---|---|
| `WorkItems READ header=あり/なし rows=n` | **そのREADにヘッダーが付いていたか**（付いていなければ virtual 項目は空） |
| `加工前: ヘッダーの生の値` | URIエンコードされたままの文字列 |
| `加工中: デコード後のJSON` | UTF-8 デコード後のJSON文字列 |
| `加工後: DTO` | Java側のレコードへ変換した結果（項目が null なら Frontend で拾えていない） |
| `virtual項目を詰めます` | ヘッダー側に表示する3つの値 |
| `明細READ 加工前CQN` | UI5 が送った `$filter` を含む受信CQN |
| `Rewritten bulk-items CQN` | `from` と `where` を書き換えた後のCQN |
| `明細READ 返却件数` | 実際に返した件数（一覧の件数と一致するか） |
| `Draft同期 <項目> before / after` | 保存時にDraftへ同期した値の前後（巻き戻り調査用） |

切り分けの順序は次のとおりです。

1. ブラウザ `①` の加工後DTO … 条件を拾えているか
2. ブラウザ `③` の試行回数と設定後ヘッダー … ヘッダーを設定できたか
3. CAP `WorkItems READ header=` … そのREADに**届いた**か（1・2が正常でもここが `なし` なら順序の問題）
4. ブラウザ `③` の refresh前／後 … 古い値なのか未到達なのか
5. CAP `明細READ 返却件数` … 明細の集合が一覧と一致するか

## 意図的に残している課題

- 同じ条件をHTTP HeaderとOData Filterの二経路で送る
- Header変更がOData Modelのアイドルタイミングに依存する
- 最初のREADとrefresh後のREADで通信が重複する
- Header変更に失敗し続けると、画面上部の検索条件が表示されない
- `sessionStorage`の単一キーなので、複数検索結果を同時保持できない
- 同じ条件を再検索する方式のため、List Report表示後にDBが変わると結果集合も変わる

これらは不具合の見落としではなく、Fが再現対象とする方式そのものの制約です。
FはEの代替設計ではなく、既存方式を比較・説明するための独立した動作サンプルです。
