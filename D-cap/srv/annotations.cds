// =============================================================================
// UI アノテーション ― Fiori Elements の画面はここで決まります
// -----------------------------------------------------------------------------
// Fiori Elements は「画面を作る」のではなく「アノテーションを読んで画面を生成」します。
// つまり下記の定義が、そのまま List Report と Object Page の見た目になります。
//
//   UI.SelectionFields … List Report のフィルタバーに並ぶ項目
//   UI.LineItem        … 表の列
//   UI.HeaderInfo      … Object Page の見出し
//   UI.Facets          … Object Page の中身（セクション）の並び
// =============================================================================
using { BulkEditService } from './bulk-edit-service';

// -----------------------------------------------------------------------------
// List Report（購買申請の一覧）
// -----------------------------------------------------------------------------
annotate BulkEditService.PurchaseRequests with @(

  // フィルタバーに出す項目。ここで絞り込んだ結果が、そのまま一括編集の対象になります。
  UI.SelectionFields: [ status, department, requestDate ],

  UI.HeaderInfo: {
    TypeName      : '{i18n>pr_typeName}',
    TypeNamePlural: '{i18n>pr_typeNamePlural}',
    Title         : { $Type: 'UI.DataField', Value: requestNo },
    Description   : { $Type: 'UI.DataField', Value: title }
  },

  UI.LineItem: [
    { $Type: 'UI.DataField', Value: requestNo,   Label: '{i18n>pr_requestNo}' },
    { $Type: 'UI.DataField', Value: title,       Label: '{i18n>pr_title}' },
    { $Type: 'UI.DataField', Value: department,  Label: '{i18n>pr_department}' },
    { $Type: 'UI.DataField', Value: status,      Label: '{i18n>pr_status}' },
    { $Type: 'UI.DataField', Value: requestDate, Label: '{i18n>pr_requestDate}' },
    { $Type: 'UI.DataField', Value: quantity,    Label: '{i18n>pr_quantity}' },
    { $Type: 'UI.DataField', Value: unitPrice,   Label: '{i18n>pr_unitPrice}' },
    { $Type: 'UI.DataField', Value: remark,      Label: '{i18n>pr_remark}' },
    { $Type: 'UI.DataField', Value: modifiedAt,  Label: '{i18n>pr_modifiedAt}' }
  ],

  // ---------------------------------------------------------------------------
  // 既定の並び順（★List Report と Object Page で必ず揃えること）
  // ---------------------------------------------------------------------------
  // SortOrder を書かないと $orderby が付かず、DB が返した順＝不定になります。
  // 一覧と明細で並びが違うと「どの行の値を直したのか」を目で追えなくなるため、
  // 両方とも申請番号の昇順に固定します。
  // 明細側の指定は下の BulkEditService.Items の PresentationVariant です。
  UI.PresentationVariant: {
    $Type        : 'UI.PresentationVariantType',
    SortOrder    : [
      { $Type: 'Common.SortOrderType', Property: requestNo, Descending: false }
    ],
    Visualizations: [ '@UI.LineItem' ]
  }
);

// -----------------------------------------------------------------------------
// 日付フィルタの制約（★ここが「ハンドラを書かずに済ませる」ための肝）
// -----------------------------------------------------------------------------
// RequiredProperties
//   … 申請日を「必須フィルタ」にします。フィルタバーの項目名に * が付き、
//     未入力のままでは検索できません（＝うっかり全件を一括編集する事故を防げます）。
//
// FilterExpressionRestrictions / AllowedExpressions: 'SingleRange'
//   … 申請日は「1つの範囲」でしか絞り込めなくなります。
//     単一日付（○月○日ちょうど）は選べません。
//
//     ここが重要な設計判断です。
//     「単一日付が来たら +60日 の範囲に広げる」という処理をサーバや画面に書くと、
//     List Report は1日分を表示しているのに一括編集は60日分を掴む、という
//     食い違いが生まれます。範囲しか選べなくすれば、その分岐自体が要りません。
//
//     なお Edm.Date かつ AllowedExpressions が SingleRange の項目には、
//     Fiori Elements の「セマンティック日付演算子」（今月・今後X日 など）が
//     自動で有効になります。初期値の指定は D-ui5/webapp/manifest.json 側で行います。
// -----------------------------------------------------------------------------
annotate BulkEditService.PurchaseRequests with @(
  Capabilities.FilterRestrictions: {
    RequiredProperties           : [ requestDate ],
    FilterExpressionRestrictions : [
      { Property: requestDate, AllowedExpressions: 'SingleRange' }
    ]
  }
);

// フリーテキスト検索（フィルタバー右上の虫めがね）の対象項目。
// ここに挙げた項目が、prepareBulkEdit の `search` 引数の検索対象と一致します。
// ※サーバ側の検索対象は BulkEditHandler.SEARCHABLE_FIELDS で定義しており、
//   「画面で検索した結果」と「一括編集の対象」がずれないよう合わせてあります。
annotate BulkEditService.PurchaseRequests with @cds.search: {
  requestNo, title, department, remark
};

// -----------------------------------------------------------------------------
// Object Page（編集セッション ＝ 絞り込み結果の全件が入った作業セット）
// -----------------------------------------------------------------------------
annotate BulkEditService.Sessions with @(

  UI.HeaderInfo: {
    TypeName      : '{i18n>session_typeName}',
    TypeNamePlural: '{i18n>session_typeNamePlural}',
    Title         : { $Type: 'UI.DataField', Value: description },
    Description   : { $Type: 'UI.DataField', Value: itemCount }
  },

  // セッションの素性（いつ・どの条件で作られ、反映済みか）を見せる欄。
  // criteria は「監査・再現用の記録」であり、ここから条件を読み直す処理はありません。
  UI.FieldGroup #SessionInfo: {
    $Type: 'UI.FieldGroupType',
    Data : [
      { $Type: 'UI.DataField', Value: itemCount, Label: '{i18n>session_itemCount}' },
      { $Type: 'UI.DataField', Value: createdAt, Label: '{i18n>session_createdAt}' },
      { $Type: 'UI.DataField', Value: createdBy, Label: '{i18n>session_createdBy}' },
      { $Type: 'UI.DataField', Value: appliedAt, Label: '{i18n>session_appliedAt}' },
      { $Type: 'UI.DataField', Value: criteria,  Label: '{i18n>session_criteria}' }
    ]
  },

  // ヘッダー（画面上部）に「対象件数」と「反映日時」を出します。
  // 「保存」を押すと、その場で元の購買申請へ書き戻されます（別途の反映ボタンはありません）。
  //   反映日時が入っていれば書き戻し済み。空欄なら、まだ一度も保存していないセッションです。
  UI.HeaderFacets: [
    {
      $Type : 'UI.ReferenceFacet',
      ID    : 'SessionStatusFacet',
      Label : '{i18n>facet_sessionInfo}',
      Target: '@UI.FieldGroup#SessionInfo'
    }
  ],

  UI.Facets: [
    {
      // ★これが一括編集の本体。絞り込み結果の全件がこのテーブルに並びます。
      //
      // Target を @UI.LineItem ではなく @UI.PresentationVariant にしているのは、
      // 「列の定義（LineItem）＋既定の並び順（SortOrder）」をまとめて渡すためです。
      // LineItem を直接指すと並び順の指定を渡せず、DB が返した順（＝不定）になります。
      $Type : 'UI.ReferenceFacet',
      ID    : 'ItemsFacet',
      Label : '{i18n>facet_items}',
      Target: 'items/@UI.PresentationVariant'
    }
  ]
);

// -----------------------------------------------------------------------------
// 明細テーブルの列
// -----------------------------------------------------------------------------
// 編集可否は「アノテーションで @readonly かどうか」で FE が自動判定します。
//   読み取り専用 : requestNo / title / department / status / applyStatus / applyMessage
//   編集可能     : quantity / unitPrice / remark   ← 行ごとに違う値を入れる列
// -----------------------------------------------------------------------------
annotate BulkEditService.Items with @(
  UI.LineItem: [
    { $Type: 'UI.DataField', Value: requestNo,  Label: '{i18n>pr_requestNo}' },
    { $Type: 'UI.DataField', Value: title,      Label: '{i18n>pr_title}' },
    { $Type: 'UI.DataField', Value: department, Label: '{i18n>pr_department}' },
    { $Type: 'UI.DataField', Value: status,     Label: '{i18n>pr_status}' },

    { $Type: 'UI.DataField', Value: quantity,   Label: '{i18n>pr_quantity}' },
    { $Type: 'UI.DataField', Value: unitPrice,  Label: '{i18n>pr_unitPrice}' },
    { $Type: 'UI.DataField', Value: remark,     Label: '{i18n>pr_remark}' },

    // Criticality に applyCriticality（0=中立/1=赤/2=黄/3=緑）を渡すと、
    // FE がステータス文字列を色付きで表示します。
    {
      $Type      : 'UI.DataField',
      Value      : applyStatus,
      Criticality: applyCriticality,
      Label      : '{i18n>item_applyStatus}'
    },
    { $Type: 'UI.DataField', Value: applyMessage, Label: '{i18n>item_applyMessage}' }
  ],

  // List Report と同じ並び順（申請番号の昇順）にします。
  // Object Page の Facet はこの PresentationVariant を指しているので、
  // ここに書いた SortOrder がそのまま明細テーブルの初期 $orderby になります。
  UI.PresentationVariant: {
    $Type        : 'UI.PresentationVariantType',
    SortOrder    : [
      { $Type: 'Common.SortOrderType', Property: requestNo, Descending: false }
    ],
    Visualizations: [ '@UI.LineItem' ]
  }
);
