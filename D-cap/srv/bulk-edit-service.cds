// =============================================================================
// BulkEditService ― 一括編集の本体サービス（画面 D-ui5 はこれだけを見ます）
// -----------------------------------------------------------------------------
// 提供するもの
//   1. PurchaseRequests … List Report で絞り込む一覧（読み取り専用）
//   2. prepareBulkEdit  … 【入口】絞り込み条件を受け取り、編集セッションを1件作る
//   3. Sessions / Items … 【編集画面】Object Page が開くセッションとその明細
//   4. 保存（draftActivate）… 【出口】確定と同時に元の購買申請へ書き戻す
//
// 処理の流れ（誰がどのタイミングで何をするか）
//   List Report「まとめて編集」ボタン
//     └▶ FE が prepareBulkEdit(criteria, search) を POST      … 条件を渡すのはここ1回だけ
//         └▶ CAP: 条件を検証 → CQN に変換 → 対象を検索 → セッション＋明細を INSERT
//             └▶ 作った Sessions を返す → FE が自動でその Object Page へ遷移
//                 └▶ ユーザーが明細をインライン編集 → Save（Draft の標準機能で一括確定）
//                     └▶ 保存の直後に CAP が元テーブルへ UPDATE（BulkEditHandler#applyOnSave）
// =============================================================================
using { sample.procurement as db } from '../db/schema';

service BulkEditService @(requires: 'authenticated-user') {

  // ---------------------------------------------------------------------------
  // 1. List Report が表示する購買申請の一覧
  // ---------------------------------------------------------------------------
  // 更新は編集セッション経由（保存時の書き戻し）でのみ行うため、画面からの直接編集は禁止。
  // （元データを1件ずつ直したい場合は PurchaseService を使う想定）
  @readonly
  entity PurchaseRequests as projection on db.PurchaseRequests;

  // ---------------------------------------------------------------------------
  // 2. 編集セッション（Object Page が開く“代表1件”）
  // ---------------------------------------------------------------------------
  // ★「反映」ボタン（bound action）は用意していません。
  //   保存＝元データへの書き戻し、にまとめてあります（BulkEditHandler#applyOnSave）。
  //   ボタンを分けると「保存したのに元データが変わらない」状態が生まれ、
  //   押し忘れたまま離脱する事故につながるためです。
  // @odata.draft.enabled が付くと CAP が Draft テーブルと標準のフローを用意します。
  //   ・「編集」を押すと Draft が作られる
  //   ・明細テーブルの入力は Draft に溜まる（＝行ごとに違う値を入れられる）
  //   ・「保存」1回で Draft → Active へまとめて反映される
  // つまり「複数行を編集して一括保存」は自前実装ではなく Draft の標準機能です。
  //
  // @restrict で「作った本人だけが読める／触れる」ようにします。
  // $user は実行中のユーザーID。managed の createdBy と突き合わせます。
  @odata.draft.enabled
  @restrict: [
    { grant: '*', to: 'authenticated-user', where: 'createdBy = $user' }
  ]
  entity Sessions as projection on db.BulkEditSessions;

  // ---------------------------------------------------------------------------
  // 3. 編集セッションの明細
  // ---------------------------------------------------------------------------
  // Composition の相手なので、サービスに公開する必要があります。
  // 画面からは Sessions/items 経由でのみアクセスします。
  entity Items as projection on db.BulkEditItems;

  // ---------------------------------------------------------------------------
  // 入口となる unbound action
  // ---------------------------------------------------------------------------
  // criteria : 絞り込み条件を表す JSON AST（形式は CriteriaTranslator.java 冒頭に記載）
  // search   : フリーテキスト検索語（任意。空文字なら無視）
  //
  // ★ここが方式の肝：条件をサーバへ渡すのは「セッションを作るこの1回だけ」。
  //   以降の画面は Sessions(ID) を開くだけなので、条件を持ち回る必要がありません。
  //   （F5 で開き直しても、ブックマークしても、同じ内容が出るのはこのため）
  action prepareBulkEdit(
    criteria : LargeString  @title: 'Filter criteria (JSON AST)',
    search   : String       @title: 'Free text search term'
  ) returns Sessions;
}

// -----------------------------------------------------------------------------
// 書き込み可否の宣言
// -----------------------------------------------------------------------------
// セッションの中身は prepareBulkEdit が確定させるものなので、
// 明細の「行追加」「行削除」は禁止します（Fiori Elements のボタンも自動的に消えます）。
annotate BulkEditService.Items with @(
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.DeleteRestrictions.Deletable : false
);

// 明細のうち「元レコードのコピー」「反映結果」は画面から書き換えられないようにします。
// 編集してよいのは quantity / unitPrice / remark の3つだけ。
annotate BulkEditService.Items with {
  sourceID         @readonly;
  sourceModifiedAt @readonly;
  requestNo        @readonly;
  title            @readonly;
  department       @readonly;
  status           @readonly;
  applyStatus      @readonly;
  applyMessage     @readonly;
  applyCriticality @readonly;
};

// セッションのヘッダー項目もすべてサーバが決めるので読み取り専用。
// （＝ユーザーが Object Page で書き換えるのは明細だけ）
annotate BulkEditService.Sessions with {
  description @readonly;
  itemCount   @readonly;
  criteria    @readonly;
  appliedAt   @readonly;
};

// セッションは prepareBulkEdit でしか作れず、画面からの新規作成は不可。
annotate BulkEditService.Sessions with @(
  Capabilities.InsertRestrictions.Insertable: false
);
