# アプリD（編集セッション方式）と アプリE（HTTPヘッダー方式）の比較分析

作成日：2026-08-12
対象：`D-cap` / `D-ui5`（編集セッション方式）、`E-cap` / `E-ui5`（HTTPヘッダー方式）
関連：[`docs/13-Dプロジェクト編集セッション方式.md`](../../docs/13-Dプロジェクト編集セッション方式.md) /
[`docs/14-E-HTTPヘッダー検索条件一括編集.md`](../../docs/14-E-HTTPヘッダー検索条件一括編集.md) /
[`docs/12-Cプロジェクト一括編集サンプル.md`](../../docs/12-Cプロジェクト一括編集サンプル.md)

同じ業務要件（List Report の絞り込み結果を Object Page でまとめて編集する）に対する
2つの実装を比較したものです。どちらが優れているという話ではなく、
**何を安全側に倒し、何を捨てたのか**を突き合わせるのが目的です。

---

## 0. 何を根拠にしているか

推測を混ぜないため、E を実際にビルド・起動して HTTP で挙動を確認しました
（D も同様に実測済み。**両方ともブラウザ画面での確認は未了**です）。

| 実測項目（E） | 結果 |
|---|---|
| ヘッダー有りで明細READ | 5件（東京/8月/OPEN）＝ 意図どおり |
| **ヘッダー無しで明細READ** | **8件＝全件**（エラーにならない） |
| Draft編集中に明細行を PATCH | アクティブデータが**即時**変更される |
| その後 Draft を破棄（キャンセル） | **元に戻らない** |
| 明細テーブル側の `$filter` | **黙って捨てられる**（大阪で絞っても東京5件が返る） |
| `$top` | 効く（CQN の limit を維持しているため） |
| 壊れたヘッダー | HTTP **500** |
| DTO に無いキーを1つ足したヘッダー | HTTP **500**「not valid JSON」 |

| 実測項目（D） | 結果 |
|---|---|
| `prepareBulkEdit`（条件JSON→セッション作成） | OK（条件に合致した件数分の明細ができる） |
| ホワイトリスト外の項目 / 0件 | どちらも **400** で拒否 |
| Draft編集 → 保存 | 元テーブルが更新される（保存に書き戻しを統合） |
| 他人が先に更新した行 | その行だけ `CONFLICT`、他行は `APPLIED` |
| 業務チェック違反行 | `ERROR`（他行は書き戻される） |
| 他ユーザーのセッション | 一覧0件 / 直接URL 404 / 保存 403 |

再現コマンドは本書末尾の付録に置いています。

---

## 1. 設計の違い

| | D（編集セッション） | E（HTTPヘッダー） |
|---|---|---|
| 「集合」の表現 | **サーバに実体を作る**（Sessions の ID） | **リクエストに付帯させる**（`X-Search-Condition`） |
| 明細の正体 | 元レコードの**コピー** | 元レコードそのもの（同一テーブルの別投影） |
| 条件を送る回数 | 1回だけ（セッション作成時） | Object Page の**通信のたび** |
| 状態の置き場所 | DB（サーバ） | sessionStorage ＋ ODataModel のヘッダー（ブラウザ） |
| 反映 | 保存と同時に書き戻し（競合検知あり）※当初は別アクション | 反映という概念が無い（直接更新） |
| Object Page のキー | セッションID（集合そのものを指す） | 任意の1レコード（実質ダミー） |
| 実装量 | 1,903行 | 668行 |

> 行数差の半分以上は D の日本語コメントと annotation です。
> 「E は D の 1/3 の複雑さ」ではなく、**せいぜい 1/2 程度**と見るのが公平です。

考え方の違いを一行で言うと：

- **D**：集合に ID を与えて、Fiori Elements の「キー1件を開く」という前提に合わせにいった
- **E**：Fiori Elements の前提はそのままに、条件を通信に相乗りさせて中身を差し替えた

---

## 2. E の良いところ

1. **とにかく小さい。** Java 1ファイル＋コントローラ2つ。
   「ヘッダーで条件を運ぶとはどういうことか」を最短距離で見せる教材として優秀。
2. **データが増えない。** コピーを作らないので、掃除処理も、古いコピーの陳腐化も、
   競合検知も要らない。**常に最新のデータを編集している**。
3. **「反映」ボタンが要らない。** 元レコードを直接編集するので手順が1つ少ない。
   （D も 2026-08-13 に保存へ統合したため、この差は無くなりました）
4. **条件がヘッダーの1本道。** C の「ヘッダーとフィルタのどちらか値が入っている方を使う」
   フォールバックを排し、`$filter` への再注入もしていない。二重管理が無い。
5. **項目名がハードコードなので、パス注入が構造的に不可能。**
   `createWhere` が `location` / `businessDate` / `status` しか書かないため、
   D のようなホワイトリスト検証を書かずに済んでいる。
   **制限の薄い設計を、意図的な機能制限で安全にしている**のは筋が良い。
6. **検索条件を画面ヘッダーに表示している**（virtual 項目 `searchLocation` / `searchPeriod` / `searchStatus`）。
   「いま何で絞った集合を見ているのか」がユーザーに見える。**この点は D より優れている**。
7. `onBeforeNavigation` で遷移前にヘッダーを設定 → **リトライループが無い**。
   C の最大の問題点を素直に潰している。

---

## 3. E の課題（重い順）

### 🔴 A. ヘッダーが無いと「全件」が出る（フォールバックの罠）

ヘッダー無しの明細READは **8件全部**を返します。
ドキュメントには「Headerがなければ通常のOData Filter処理」とありますが、
`bulkEditItems` の ON 条件が `bulkEditItems.ID = bulkEditItems.ID`（常に真）なので、
**実体は「無条件で全件」**です。

現実に起きる経路：

- Object Page の URL をブックマーク／別タブで開く（sessionStorage はタブ単位）
- URL を同僚に共有する
- ブラウザやプロキシがカスタムヘッダーを落とす
- `changeHttpHeaders` が例外を投げた
  （ODataModel V4 は**リクエスト実行中に呼ぶと例外**。`earlyRequests: true` と競合しうる）

そのまま**全件が一括編集の対象になり得る**ため、影響は「表示が変」では済みません。
C の問題点として挙げた「条件が無いときの扱いが曖昧」が形を変えて残っています。
**ここは 400 で止めるべき**です。

### 🔴 B. 編集が Draft を経由しておらず、キャンセルが効かない

「Object Page の編集モードで複数行を変更 → 保存」に見えますが、実際は：

- `WorkItemBulkItems` は Draft 無効の投影 → 行を編集した瞬間に**アクティブデータへ PATCH**
- Draft を破棄しても**戻らない**（実測）
- つまり「一括保存」でも「まとめて確定」でもなく、**逐次コミット**

さらに Object Page のルート行自身も明細テーブルに含まれるため、
**同じレコードに Draft 経由の更新とアクティブ直接更新が並走**します
（Draft を保存した時点で明細での編集が巻き戻る可能性）。C が踏んだ地雷と同種です。

Java の `@Before UPDATE` のコメント「一括保存時は、変更された行ごとにこのログが出ます」は、
実態と食い違っています。

### 🟠 C. 4項目固定 DTO の拡張性と、暗黙の切り捨て

- `applyFilter` は `location` / `status` / `businessDate` **以外を黙って捨てる**。
  担当者で絞って一括編集すると、List Report は絞れているのに
  **明細テーブルはもっと広い集合**になる（A と同じ「見えている結果 ≠ 編集対象」）。
- 逆に、フロントの DTO にキーを1つ足して Java を直し忘れると、
  **全リクエストが 500**（Jackson の `FAIL_ON_UNKNOWN_PROPERTIES`）。
  しかもメッセージは「not valid JSON」で原因が分からない。
- 項目を1つ増やすたびに **TS の型・Java の record・`createWhere`** の3箇所を直す必要がある。

### 🟠 D. 明細テーブル側の `$filter` が消える

CQN の `where` を丸ごと差し替えているため、ソートやページングは効くのに、
**列フィルタや追加条件は無言で消えます**（実測）。
効く操作と効かない操作が見た目で区別できないのは、UI として厄介です。

### 🟡 E. CQN を文字列 JSON として組み立てている

`context.getCqn().toString()` → Jackson で `from` を差し替え → `Select.cqn(String)` で再パース。
動いてはいますが **CAP の CQN JSON 内部表現に依存**しており、バージョン更新で壊れうる箇所です。
D が使う `CQL.get(...).eq(...)` は公開 API なので、この点は D が堅い。

### 🟡 F. 型の扱いが H2 依存

`businessDate >= "2026-08-01"` を**文字列リテラル**として CQN に載せています。
H2 では通りますが、Date 型との比較は DB 方言差が出やすい箇所です（HANA 移行時の定番）。
D は `LocalDate` に変換してから渡しています。

### 🟡 G. 認証・権限・エラーコード

- `service WorkItemService` に `@requires` が無く、**誰でも読める・書ける**
- 例外が `IllegalArgumentException` / `IllegalStateException` → **500**。
  `ServiceException(ErrorStatuses.BAD_REQUEST, …)` にすべき
- 「未指定」などの文言が Java にハードコード（i18n の外）

---

## 4. D の良いところ

1. **URL だけで画面が再現できる。** ブックマーク・F5・共有・別タブすべてで同じ集合。
   E の課題 A が構造的に発生しない。
2. **条件が解釈できなければ 400 で止まる。**
   ホワイトリスト（項目・演算子・ネスト深さ・条件数）を通過しない限りクエリを組み立てない。
3. **Draft の標準機能に完全に乗っている。**
   明細のインライン編集 → 1回の保存で確定、キャンセルで巻き戻る、が本当にそのとおり動く。
4. **競合検知と部分成功。** `sourceModifiedAt` の突き合わせで、
   他人が先に更新した行だけ `CONFLICT` にして残りは通す。
5. **所有者以外から見えない**（`@restrict` ＋ ハンドラの二重防御）。
6. **監査の跡が残る。** 誰がいつどの条件で何件を対象にしたかが DB に残る。
7. **日付フィルタが宣言だけで完結**（必須・範囲限定・本日起点60日。コード0行）。

---

## 5. D の課題（自己批判）

### ✅ A.（解消済み）ユーザー手順が1つ多い

当初は「保存」してから「反映」の2段階で、
**保存しただけで離脱すると元データが1件も変わらない**という穴がありました。
2026-08-13 に「保存＝書き戻し」へ統合し、この問題は解消しています
（`BulkEditHandler#applyOnSave`：draftActivate の After ハンドラ）。
行単位の成否記録（`APPLIED` / `UNCHANGED` / `CONFLICT` / `ERROR`）はそのまま残しています。

### 🟠 B. コピーゆえの陳腐化

セッション作成時点のスナップショットなので、時間が経つほど `CONFLICT` が増えます。
E は常に最新を編集するのでこの問題がありません。
**「安全だが手戻りが増える」という代償**です。

### 🟠 C. データが増える

1セッション最大500行、Draft に入るとさらに複製。
掃除処理は**アクティブなセッションしか消しません**
（Draft のまま放置された残骸と `DraftAdministrativeData` は残る）。ここは実装が不完全です。

### 🟠 D. 概念が増える

ユーザーから見て「編集セッション」という新しいオブジェクトが増えます。
E は「作業項目を検索して編集する」だけで、業務担当者には理解しやすい。

### 🟡 E. 0件が 400 エラー

「絞り込んだら0件だった」は業務上ふつうの出来事で、赤いエラーダイアログは過剰です。
フロントで先に件数を見て情報メッセージにしていますが、結果として二重実装になっています。

### 🟡 F. 未検証部分と余計なもの

- カスタムアクションの `press` 解決（`this` が ExtensionAPI かコントローラか）は**ブラウザ未確認**
  （`requiresNavigation` は unbound action では機能しないことが判明し、
  `getRouting().navigateToRoute()` による明示遷移へ変更済み）
- 件数の事前取得が余分な1往復。サーバ判定とレース条件になり得る
- `PurchaseService` は画面から使われない（説明用の存在）
- 同じ元レコードを含む複数セッションを同時に保存するとロックが無い（行単位の後勝ち）

---

## 6. 両方に共通する弱点

1. **UI5 の Filter 内部プロパティ（`aFilters` / `sPath` / `oValue1`）を読んでいる。**
   公開 API ではないので、MDC の表現が変わると両方壊れます。
   差は「壊れたときに D は例外を投げ、E は黙って条件を捨てる」点。
2. **「画面の絞り込み結果 ＝ 編集対象」の保証が、フロントの変換処理の正しさに依存**している。
   サーバは渡された条件で検索するだけなので、変換にバグがあれば両方とも意図しない集合を掴む。
3. どちらもブラウザでの画面確認が未了。
4. サンプルデータの日付がハードコード。

---

## 7. 結論

**学習・説明用としては E、実務に持っていくなら D。**

- E は「ヘッダーで条件を運ぶ」という仕組みの教材として優秀。
  ただし**このまま本番の一括更新には使えない**（§3 A・B が致命的）。
- D は安全側に倒しすぎて概念が増えている（当初の最大リスクだった「反映」忘れは、
  保存への統合で解消済み）。

一本化するなら、**E の骨格に D の安全装置を移植する**のが現実的です（優先度順）：

| # | やること | 対応する課題 |
|---|---|---|
| 1 | **ヘッダーが無い明細READは 400 で拒否**（全件フォールバックを廃止） | §3 A ← ここだけは必須 |
| 2 | 明細を Draft 有効にする。難しければ**逐次コミットであることを UI で明示** | §3 B |
| 3 | `@JsonIgnoreProperties(ignoreUnknown = true)` ＋ **未対応の条件項目は 400**（対象項目を1箇所で定義） | §3 C |
| 4 | 例外を `ServiceException(BAD_REQUEST)` に変え、`@requires: 'authenticated-user'` を付ける | §3 G |
| 5 | 日付を `LocalDate` に変換してから CQN へ | §3 F |
| 6 | 逆に **D へ E のヘッダー Facet（検索条件の可読表示）を移植** | §5 D |
| 7 | D の掃除処理で Draft の残骸も消す | §5 C |
| 8 | ~~D に「未反映のまま離脱」警告を追加~~ → 保存と書き戻しを統合して解消済み | §5 A |

読ませる順番としては
**`docs/12`（C＝アンチパターン）→ `docs/14`（E＝最小実装と、残る危険）→ `docs/13`（D＝安全側の作り）**
が、「なぜここまでやるのか」が一番腑に落ちる並びです。

---

## 付録：実測に使ったコマンド

ホストに java / mvn が無いため、docker のイメージでビルド・起動しています
（devcontainer 内なら `mvn` をそのまま使えます）。

```bash
# ビルド
docker run --rm -u $(id -u):$(id -g) -e HOME=/m2 \
  -v /path/to/fiori-study:/ws -v <作業用ディレクトリ>:/m2 \
  -w /ws/E-cap/srv maven:3.9-eclipse-temurin-21 mvn -B -DskipTests package

# 起動（4008）
docker run -d --rm --name e-cap-test -p 4008:4008 -u $(id -u):$(id -g) -e HOME=/m2 \
  -v /path/to/fiori-study:/ws -v <作業用ディレクトリ>:/m2 \
  -w /ws/E-cap/srv maven:3.9-eclipse-temurin-21 java -jar target/e-header-edit-exec.jar
```

```bash
B=http://localhost:4008/odata/v4/WorkItemService
ID=880e8400-e29b-41d4-a716-446655440101
ITEM=880e8400-e29b-41d4-a716-446655440102
H=$(python3 -c 'import urllib.parse,json;print(urllib.parse.quote(json.dumps(
  {"location":"東京","fromDate":"2026-08-01","toDate":"2026-08-31","status":"OPEN"},ensure_ascii=False)))')

# ① ヘッダー無し → 8件（全件）が返る
curl -s "$B/WorkItems(ID=$ID,IsActiveEntity=true)/bulkEditItems?\$count=true&\$select=name"

# ② ヘッダー有り → 5件
curl -s -H "X-Search-Condition: $H" \
  "$B/WorkItems(ID=$ID,IsActiveEntity=true)/bulkEditItems?\$count=true&\$select=name"

# ③ 明細テーブル側の $filter は無視される（大阪で絞っても東京5件）
curl -s -H "X-Search-Condition: $H" \
  "$B/WorkItems(ID=$ID,IsActiveEntity=true)/bulkEditItems?\$count=true&\$filter=location%20eq%20%27大阪%27"

# ④ Draft 編集中の明細 PATCH がアクティブへ即反映され、Draft 破棄で戻らない
curl -s -X POST "$B/WorkItems(ID=$ID,IsActiveEntity=true)/WorkItemService.draftEdit" \
  -H 'Content-Type: application/json' -d '{"PreserveChanges":true}'
curl -s -X PATCH "$B/WorkItemBulkItems($ITEM)" \
  -H 'Content-Type: application/json' -d '{"actualQuantity":999}'
curl -s "$B/WorkItems?\$filter=ID%20eq%20$ITEM&\$select=name,actualQuantity"   # → 999
curl -s -X DELETE "$B/WorkItems(ID=$ID,IsActiveEntity=false)"                  # Draft 破棄
curl -s "$B/WorkItems?\$filter=ID%20eq%20$ITEM&\$select=name,actualQuantity"   # → 999 のまま

# ⑤ 壊れたヘッダー / 未知のキー → いずれも 500
curl -s -H "X-Search-Condition: %7Bbroken" "$B/WorkItems(ID=$ID,IsActiveEntity=true)/bulkEditItems"
```
