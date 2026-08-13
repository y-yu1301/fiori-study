# D・E 一括編集方式の比較分析

## 1. 結論

元の改修要件にある制約を優先する場合は、EのHTTP Header方式が適しています。

- DB Entityを追加しない
- List Reportの行クリックによる標準Navigationを維持する
- Object PageのRootや画面構造を変更しない
- Session Storageを既存構成として継続利用する
- HTTP Headerを業務検索条件の唯一の正とする

一方、実運用で複数レコードを安全に編集し、再読込や同時更新まで考慮する場合は、
Dの編集セッション方式の方が堅牢です。

ただし、Dは次の禁止事項に該当するため、今回の改修要件にはそのまま採用できません。

- `BulkEditSessions`、`BulkEditItems`というDB Entityを追加している
- 標準の行クリックではなく、カスタムアクションからObject Pageへ遷移する
- Object PageのRootを元データから編集セッションへ変更している
- Object Page本文をDraft Compositionとして再構成している

したがって、現時点の判断は次のとおりです。

| 判断軸 | 適する方式 |
|---|---|
| 今回の制約を守った最小改修 | E |
| 本番での安全性・再現性・拡張性 | D |
| 将来のSearchContext ID方式への発展 | Dに近い方式 |

## 2. 全体比較

| 観点 | E：HTTP Header方式 | D：編集セッション方式 |
|---|---|---|
| DB Entity追加 | なし | Session、Itemsを追加 |
| Navigation | 標準の行クリックを維持 | カスタムアクション経由 |
| Object Page Root | 選択した元データ | 編集セッション |
| 検索条件の正 | `X-Search-Condition` | Session作成時の条件 |
| 条件の受け渡し | Object Pageの各HTTP通信 | `prepareBulkEdit`の1回だけ |
| URL/F5での再現性 | 弱い | 強い |
| 対象集合の固定 | しない。READごとに再検索 | Session作成時に固定 |
| Draft構造 | Rootと本文がCompositionではない | SessionとItemsがComposition |
| 同時更新対策 | なし | `modifiedAt`による競合検知あり |
| 実装量 | 比較的少ない | 多い |
| 今回の制約への適合 | 高い | 低い |
| 本番運用上の安定性 | 中～低 | 高い |

## 3. Eの良い点

### 3.1 今回の制約を維持できる

EではSearchContext用のDB Entityを追加していません。

DB Entityは`WorkItems`だけで、Object Page本文用の`WorkItemBulkItems`は同じEntityの
サービス投影です。

```cds
entity WorkItemBulkItems as projection on db.WorkItems;
```

List Reportの行クリックでは、`onBeforeNavigation`内でHeaderを設定したあと`false`を返し、
Fiori Elementsの標準Navigationを続行します。

### 3.2 条件DTOが単純

Eの条件は要件にある4項目だけです。

```json
{
  "location": "東京",
  "fromDate": "2026-08-01",
  "toDate": "2026-08-31",
  "status": "OPEN"
}
```

Dのような汎用Filter ASTと比べて、条件の意味とCAP側のWHERE変換が理解しやすい構成です。

### 3.3 Header解析とWHERE生成が集約されている

Eでは次の処理を`WorkItemsHandler`へ集約しています。

- `X-Search-Condition`の取得
- URIデコード
- JSON Parse
- Header DTOからCQN `where`への変換
- Object Page Header用virtual項目の生成

FrontendからObject Page本文へ同じ条件をOData Filterとして再注入していないため、
業務条件の管理経路はHeaderの1本です。

### 3.4 Header設定タイミングが明確

通常の遷移では、List Reportの`onBeforeNavigation`でObject Page開始前にHeaderを設定します。

Object Pageの`onBeforeBinding`にも同じ処理を置いていますが、タイマー、再Binding、
リトライループはありません。

### 3.5 HeaderとTableが同じ条件を参照する

Object PageのルートREADと本文TableのREADには、同じOData ModelのHeaderが付与されます。

CAP側では次のように利用します。

- Object Page Header: Headerから`searchLocation`、`searchPeriod`、`searchStatus`を生成
- Object Page Table: Headerから業務WHEREを生成して`WorkItemBulkItems`を再検索

## 4. Eの悪い点・課題

### 4.1 Draft Compositionになっていない

Eで最も重要な確認事項です。

```cds
@odata.draft.enabled
entity WorkItems as projection on db.WorkItems {
  *,
  bulkEditItems : Association to many WorkItemBulkItems
    on bulkEditItems.ID = bulkEditItems.ID
};
```

Draft Rootは`WorkItems`ですが、本文の`WorkItemBulkItems`は非Draft EntityへのAssociationです。

CAP/Fiori Elementsで親と明細を一度の保存操作で確定する標準構造は、通常、Draft Rootからの
Compositionです。Eでは次の動作が保証されていません。

- Object Pageの編集モードで本文セルが期待どおり編集可能になるか
- 本文の変更がObject Pageの保存まで保留されるか
- 複数行が同じChangesetまたはトランザクションで更新されるか
- 保存キャンセル時に本文変更も取り消されるか
- Object Page Rootと本文に同じレコードが含まれる場合、RootのDraftが本文の更新を上書きしないか

EではREAD API、CAPビルド、UI5ビルドまでは確認済みですが、ブラウザ上でのDraft編集から保存、
キャンセルまでの一連の動作確認は未実施です。

### 4.2 日付がタイムゾーンでずれる可能性がある

EではJavaScriptの`Date`を次のように変換しています。

```ts
value.toISOString().slice(0, 10)
```

`toISOString()`はUTCへ変換するため、ローカル日付の午前0時がUTCでは前日になる可能性があります。

例：日本時間の`2026-08-01 00:00`が`2026-07-31`として保存される可能性があります。

Dでは`getFullYear()`、`getMonth()`、`getDate()`を使い、ローカル日付のまま
`yyyy-MM-dd`へ変換しています。この点はDの実装の方が適切です。

### 4.3 Headerありの場合に元のWHEREをすべて削除している

EではHeaderが存在すると、元CQNの`where`をHeader条件で置き換えます。

これは「Headerを業務条件の唯一の正とする」という方針には合っていますが、次の条件も消えます。

- Object Page本文テーブル固有のFilter
- 将来追加される非業務条件
- 標準機能が`where`へ追加する可能性がある条件

今回の固定要件では単純ですが、将来Table側の絞り込みを追加する場合は、
「Header管理項目だけをHeader条件へ置き換え、それ以外を維持する」という整理が必要です。

### 4.4 空条件と条件取得失敗を区別できない

Session Storageに`{}`が保存されると、Headerは「存在する」と判定されます。

CAP側ではWHEREなしの`WorkItemBulkItems` READとなるため、全件が対象になります。

次の2つを区別できません。

- ユーザーが意図して条件なし検索を実行した
- UI5のバージョン差やタイミング問題で条件を取得できなかった

一括更新用途では、取得失敗を全件検索へフォールバックしない方が安全です。

### 4.5 Header欠落時に誤動作が見えにくい

Headerが無い場合、CAPは通常のNavigation CQNを実行します。

その結果、エラーではなく、選択した1レコードだけが本文へ表示される可能性があります。
利用者から見ると「一括編集対象が1件だけになった」ように見え、原因を判断しにくくなります。

### 4.6 Session Storageの1キーで状態が上書きされる

Eでは次の1キーだけを使います。

```text
e.header.edit.searchCondition
```

同じタブで別の検索を実行すると、以前のObject Pageが参照する条件も上書きされます。

ブラウザ履歴で以前のObject Pageへ戻った場合、同じURLでも本文が別の検索結果になる可能性があります。

### 4.7 HeaderはOData Model全体へ作用する

`changeHttpHeaders`はObject PageのTableだけでなく、同じOData Modelから発行される通信全体へ
作用します。

EではList Reportのrebind時にHeaderを削除していますが、Header状態の切り替えが
画面ライフサイクルへ依存している点は残ります。

### 4.8 CQNをJSON文字列として書き換えている

Eは`context.getCqn().toString()`をJSONとして解析し、`from`と`where`を書き換えています。

最小サンプルとしては動作しますが、CAPのCQN構造変更や複雑なQueryに対しては、
Dの型付き`CQL` APIより壊れやすい実装です。

## 5. Dの良い点

### 5.1 Object Pageの標準的なデータ構造に合っている

Dでは編集対象集合を表す`BulkEditSessions`をObject Page Rootにし、
`BulkEditItems`をComposition明細にしています。

```cds
entity BulkEditSessions : cuid, managed {
  items : Composition of many BulkEditItems on items.parent = $self;
}
```

この構造により、次の処理をFiori ElementsとCAP Draftの標準機能へ任せられます。

- Object Pageの編集モード
- 複数明細のインライン編集
- 保存とキャンセル
- 親子のDraft管理
- 1回の保存による親子の確定

### 5.2 条件を持ち回らない

Dでは条件を`prepareBulkEdit`の1回だけサーバへ送信します。

サーバはその時点の対象データを`BulkEditItems`へコピーします。それ以降はSession IDだけで
Object Pageを表示できるため、次の問題がありません。

- Session Storageの上書き
- HTTP Headerの設定タイミング
- Object Page READごとの条件再解析
- Header設定リトライ
- OData Model全体へのHeader残留

### 5.3 URLと画面内容が一致する

DのObject Page URLはSession IDを持ちます。

同じURLをF5、ブックマーク、別タブで開いても、同じ`BulkEditItems`が表示されます。

EではURLが元レコードのIDだけで、本文の集合はSession Storageによって変わります。

### 5.4 元データと編集中データを分離できる

Dは元データを`BulkEditItems`へコピーします。

編集途中では元データを変更せず、明示的な`applyBulkEdit`アクションで反映します。

これにより、元データ自身のDraftや別ユーザーの編集中データと衝突しにくくなります。

### 5.5 競合と部分失敗を画面へ残せる

DではSession作成時の`modifiedAt`を`sourceModifiedAt`として保存します。

反映時に現在の`modifiedAt`と比較し、競合した行を上書きしません。

各行には次の状態を保存します。

- `PENDING`
- `APPLIED`
- `CONFLICT`
- `ERROR`

一部の行だけ失敗した場合も、利用者が対象行と理由を確認できます。

### 5.6 条件変換が型付きである

Dの`CriteriaTranslator`は、条件JSONをCAPの`Predicate`へ変換します。

- 項目ごとの型変換
- 許可項目の明示
- 許可演算子の明示
- AND/ORの維持
- 日付・数値の型付き変換
- 不正条件を400エラーで拒否

EのJSON CQN書き換えより、条件が増えた場合の拡張性があります。

### 5.7 日付をローカル日付として変換している

Dの`filterSerializer.ts`では、時刻を持たない`Date`をローカル年月日から
`yyyy-MM-dd`へ変換しています。

日付項目を`toISOString()`へ変換しないため、タイムゾーンによる前日ずれを避けられます。

## 6. Dの悪い点・課題

### 6.1 今回の制約に適合しない

Dは設計としては堅牢ですが、今回禁止されている変更を含んでいます。

| 制約 | Dの状態 |
|---|---|
| 新規SearchContext系テーブル禁止 | Session、Itemsを追加 |
| Navigation方式変更禁止 | カスタムアクション経由へ変更 |
| Entity構成変更禁止 | Session Root、Compositionを追加 |
| Object Page構造変更禁止 | SessionのObject Pageへ変更 |

そのため、今回の開発終盤の改修へそのまま取り込むことはできません。

### 6.2 競合チェックとUPDATEが原子的ではない

Dでは次の順番で処理しています。

1. 元レコードをSELECT
2. `sourceModifiedAt`と現在の`modifiedAt`をJavaで比較
3. IDをキーにUPDATE

比較とUPDATEの間に別処理が更新すると、その更新を上書きする可能性があります。

より堅牢な楽観ロックは、UPDATE自体に次の条件を付けます。

```text
WHERE ID = :sourceID
  AND modifiedAt = :sourceModifiedAt
```

更新件数が0なら`CONFLICT`と判定します。

### 6.3 上限件数がFrontendとBackendで二重管理されている

Dでは`MAX_ITEMS = 500`がFrontendにあり、Backendにも`bulk-edit.max-items`があります。

値がずれると、FrontendとBackendで異なるメッセージや判定になります。

Backendを最終的な正とし、Frontendの件数確認は早期警告だけにする整理が必要です。

### 6.4 対象検索が2回発生する

Frontendは事前に件数を取得し、その後Backendの`prepareBulkEdit`が対象を再検索します。

2回のREAD間でデータが変わる可能性があるため、Frontendの件数は参考値であり、
正しい上限判定はBackend側の結果です。

### 6.5 サンプルとしては実装量が多い

Dには次の機能が含まれています。

- 汎用Filter AST
- Frontend/Backend双方の条件検証
- Session所有者制御
- Mock認証
- 競合検知
- 部分成功
- 反映結果表示
- Session Cleanup Job
- 件数上限
- Side Effects

本番設計の学習サンプルとしては有用ですが、今回の最小改修サンプルとしては中心処理を
追いにくくする要因になります。

### 6.6 Sessionデータの運用が必要

未反映SessionはCleanup Jobで削除されますが、反映済みSessionは残り続けます。

監査データとして残す場合でも、保持期間、アーカイブ、削除方針が必要です。

また、Cleanupは`createdAt`を基準にしているため、作成から保持時間を超えて編集中のSessionも
削除対象になる可能性があります。編集中判定や`modifiedAt`基準の検討が必要です。

### 6.7 保存と反映が別操作になる

Dでは次の2段階です。

1. Object Pageの保存でSession明細を確定
2. 「購買申請へ反映」で元データを更新

安全性は高い一方、利用者が「保存したので元データも更新済み」と誤認する可能性があります。

ボタン名、メッセージ、画面状態によって、二段階処理であることを明確にする必要があります。

### 6.8 UI5 Filterの内部プロパティに依存している

Dの`filterSerializer.ts`は次の内部プロパティを参照します。

- `aFilters`
- `bAnd`
- `sPath`
- `sOperator`
- `oValue1`
- `oValue2`

UI5のバージョン変更でFilterの内部表現が変わると、条件取得が壊れる可能性があります。

## 7. 両方式に共通する根本課題

### 7.1 List Report表示結果との厳密な完全一致

条件を再実行する方式では、List Reportに表示されたID集合との厳密な一致を保証できません。

```text
List Report READ
  ↓ この間に別ユーザーが登録・更新・削除
Object Page READ または prepareBulkEdit
```

この間にデータが変わると、同じ条件でも結果が変わります。

- EはObject PageのREADごとに条件を再実行するため、表示中にも集合が変わり得る
- Dは`prepareBulkEdit`時点で集合を固定するが、List Report表示時点との差は発生し得る

厳密な完全一致には、List Report取得時点のID一覧またはSearchContext IDをサーバで固定する必要が
あります。これは今回の禁止事項に含まれる将来方式です。

### 7.2 Frontend Filter構造への依存

EとDのどちらも、最終的にはUI5 Filterオブジェクトから検索条件を読み取ります。

Filter取得API、内部プロパティ、セマンティック日付の展開方法が変わると影響を受けます。

使用するUI5バージョンで、次を実際のブラウザ通信から確認する必要があります。

- 単一値
- 日付範囲
- AND/OR
- Variant復元
- 初期値
- 値変更後の再検索
- 戻る操作

## 8. 相互に参考にできる点

### 8.1 EがDから参考にできる点

DB EntityやNavigation方式を変更しない範囲でも、次は参考にできます。

- 日付をローカル年月日として変換する
- 条件取得失敗時に全件へフォールバックしない
- 0件、全件、上限件数を明示的に扱う
- Backendを件数判定の最終的な正とする
- 文字列CQN操作ではなくCAPの型付きCQL APIを利用する
- 更新可能項目を明示する
- 更新前に競合または更新日時を確認する
- エラーを握りつぶさず、利用者へ理由を表示する

ただし、Draft Compositionを使わずにDと同じ一括保存の安全性を得ることは困難です。

### 8.2 DがEから参考にできる点

Dを要件限定のサンプルとして簡略化する場合は、次を参考にできます。

- 場所、開始日、終了日、ステータスだけの固定DTOにする
- 汎用Filter ASTを要件で必要になるまで導入しない
- Frontendの事前件数READを省略し、Backendだけで判定する
- FrontendとBackendの上限値二重管理を避ける
- セキュリティ、Cleanup、部分成功を別の発展サンプルへ分離する
- 中心となる「対象集合を固定してCompositionで編集する」流れを先に見せる

## 9. E採用前に必要な確認

Eを今回の要件向けサンプルとして採用する場合は、少なくとも次をブラウザで確認する必要があります。

1. List Reportで場所・日付範囲・ステータスを入力する
2. 検索結果のID一覧を記録する
3. 行クリックによる標準NavigationでObject Pageへ移動する
4. Object Page Headerへ同じ検索条件が表示される
5. Object Page本文のID一覧がList Reportと一致する
6. Object Pageを編集モードにする
7. 本文の異なる複数行へ異なる値を入力する
8. 保存前にDBへUPDATEされていないことを確認する
9. 保存操作で全変更が反映されることを確認する
10. キャンセル操作で全変更が破棄されることを確認する
11. 選択したRoot行が本文にも含まれる場合、保存後の値を確認する
12. 日本時間で日付条件が前日にずれないことを確認する
13. 戻る、再検索、履歴で戻る、F5を確認する
14. Headerなし、空条件、条件取得失敗時の動作を確認する

特に手順6～11が成功しない場合、EのREAD条件引き継ぎは成立していても、
「Object Page内で複数レコードをまとめて編集する」という完了条件は満たしていません。

## 10. 最終判断

### 今回の改修要件を優先する場合

Eを基準にします。

ただし、次の2点は採用前の必須確認です。

- Association本文テーブルのDraft編集・保存・キャンセル
- 日付のタイムゾーン変換

### 制約を緩和できる場合

DのSession＋Composition方式の方が、Fiori ElementsとCAPの標準構造に合っています。

本番採用する場合は、次を改善する必要があります。

- `modifiedAt`をUPDATE条件へ含めた原子的な競合検知
- Sessionの保持・削除方針
- FrontendとBackendの上限値二重管理
- 保存と反映が二段階であることの明確化

### 将来方式

要件に記載されたSearchContext ID方式は、Eの最小変更とDの安定性の中間に位置します。

```text
List Report検索
  ↓
対象条件またはID集合をサーバで固定
  ↓
Context IDを発行
  ↓
Object PageはContext IDだけを使用
```

この方式なら、HTTP Headerには大きな条件JSONではなくContext IDだけを載せられ、
URLと対象集合の対応、複数検索結果の同時保持、再読込への対応がしやすくなります。

ただし、DBまたはキャッシュ上のContext管理が必要になるため、今回の最小改修の範囲外です。
