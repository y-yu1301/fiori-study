/*
 * =============================================================================
 * srv/cat-service.cds  ―  サービス（外部に公開するAPI）の定義
 * -----------------------------------------------------------------------------
 * db/schema.cds が「DBの中身」だとすると、こちらは「外に見せる窓口」です。
 * ここで定義したものが OData という形式の Web API として自動公開され、
 * ブラウザや Fiori 画面からアクセスできるようになります。
 *
 * ★このファイルも CAP Node.js / CAP Java で「まったく同じ」書き方です。
 *   起動方法で公開先が変わります:
 *     - `cds watch`（Nodeモック）        … http://localhost:4004/odata/v4/catalog
 *     - `cd srv && mvn spring-boot:run`（本物のJava）… /odata/v4/CatalogService
 *       （application.yaml で server.port:4004 に固定済み）
 *   本番相当は Java 側。Fiori アプリは /odata/v4/CatalogService を参照します。
 *
 * ポイント：DBテーブルをそのまま公開するのではなく、
 * 「projection(射影＝必要な部分だけ映したもの)」として公開します。
 * =============================================================================
 */

// さっき作ったデータモデルを読み込みます。
using { fiori.study as my } from '../db/schema';

/**
 * CatalogService という名前のサービスを定義。
 */
service CatalogService {

  // Books テーブルを "Books" という名前で公開。
  // @readonly を付けると読み取り専用（一覧・詳細の表示だけ）になります。
  // ※ 学習の最初は読み取り専用が安全。編集も試したくなったら外してください。
  @readonly
  entity Books   as projection on my.Books;

  // Object Page 内の関連テーブルとして表示する編集対象。
  // ここに List Report の検索条件を $filter として差し込むサンプル。
  entity BookSchedules as projection on my.BookSchedules;

  // Authors も同様に公開。
  @readonly
  entity Authors as projection on my.Authors;
}

/*
 * -----------------------------------------------------------------------------
 * ここから下は「アノテーション(注釈)」です。
 * Fiori Elements は、このアノテーションを読んで“自動で”画面を組み立てます。
 * 画面レイアウトを手でコーディングする代わりに、
 * 「どの項目を一覧に出すか」「タイトルは何か」をここで宣言します。
 * ―― これが Fiori Elements の「アノテーション駆動」という考え方です。
 *     （この仕組みも Node.js/Java で共通。フロントは UI5 で同じだからです）
 * -----------------------------------------------------------------------------
 */
// ★ラベルは直書きせず {i18n>キー} で参照します。
//   キーの実体は _i18n/i18n*.properties にあり、言語ごとに解決されます。
//   これで「表示文言は CAP 側で一元管理」（現場と同じ形）になります。
annotate CatalogService.Books with @(
  // UI.LineItem = 一覧表(List Report)に表示する列の並び。
  UI.LineItem: [
    { Value: title,        Label: '{i18n>book_title}' },
    { Value: author.name,  Label: '{i18n>book_author}' },  // 関連先(Authors)の名前も列に出せる
    // relatedMovieTitle は「見せる文字」、relatedMovieUrl は「クリック先」。
    // つまり、1列で「映画名を表示しつつ、B 側の映画詳細へ飛べる」ようにする。
    {
      $Type : 'UI.DataFieldWithUrl',
      Value : relatedMovieTitle,
      Url   : relatedMovieUrl,
      Label : '{i18n>book_relatedMovie}'
    },
    { Value: stock,        Label: '{i18n>book_stock}' },
    { Value: price,        Label: '{i18n>book_price}' },
    { Value: availableDate, Label: '{i18n>book_availableDate}' }
  ],

  // UI.PresentationVariant.RequestAtLeast = 画面に直接表示しないが、
  // 一覧取得時の $select に最低限含めてほしい項目。
  // relatedMovieTitle/Url は Java 後処理で作るため、元になる relatedMovie_ID が必要。
  UI.PresentationVariant: {
    RequestAtLeast: [ relatedMovie_ID ],
    Visualizations: [ '@UI.LineItem' ]
  },

  // UI.HeaderInfo = 詳細画面(Object Page)のヘッダに出すタイトル情報。
  UI.HeaderInfo: {
    TypeName      : '{i18n>book_typeName}',
    TypeNamePlural: '{i18n>book_typeNamePlural}',
    Title         : { Value: title }
  },

  // UI.FieldGroup = 詳細画面に並べる項目のまとまり。
  UI.FieldGroup #Details: {
    Data: [
      { Value: title,       Label: '{i18n>book_title}' },
      { Value: author.name, Label: '{i18n>book_author}' },
      { Value: descr,       Label: '{i18n>book_descr}' },
      { Value: stock,       Label: '{i18n>book_stock}' },
      { Value: price,       Label: '{i18n>book_price}' },
      { Value: availableDate, Label: '{i18n>book_availableDate}' }
    ]
  },

  // UI.Facets = 詳細画面のどこに上のFieldGroupを配置するか。
  UI.Facets: [
    {
      $Type : 'UI.ReferenceFacet',
      Label : '{i18n>facet_details}',
      Target: '@UI.FieldGroup#Details'
    },
    {
      $Type : 'UI.ReferenceFacet',
      Label : '{i18n>facet_schedules}',
      Target: 'schedules/@UI.LineItem'
    }
  ]
);

annotate CatalogService.Books with @(
  UI.SelectionFields: [
    availableDate
  ]
);

annotate CatalogService.BookSchedules with @(
  UI.LineItem: [
    { Value: businessDate, Label: '{i18n>schedule_businessDate}' },
    { Value: quantity,     Label: '{i18n>schedule_quantity}' },
    { Value: note,         Label: '{i18n>schedule_note}' }
  ],
  UI.FieldGroup #Details: {
    Data: [
      { Value: businessDate, Label: '{i18n>schedule_businessDate}' },
      { Value: quantity,     Label: '{i18n>schedule_quantity}' },
      { Value: note,         Label: '{i18n>schedule_note}' }
    ]
  }
);

/*
 * -----------------------------------------------------------------------------
 * author（著者）の入力候補（ValueList）。
 * -----------------------------------------------------------------------------
 * 元は UI5 側(app/project1/annotations.cds)にありましたが、CAP と UI5 を分離し
 * 「表示・データ由来のアノテーションは CAP 側に一元化」する方針のため、こちらへ移設。
 * これで UI5(A-ui5) は CAP のファイルを一切参照せず、OData 越しに
 * このアノテーション（$metadata に反映）を受け取るだけになります。
 *
 * 効果：詳細画面で著者を選ぶとき、Authors 一覧から選べる候補ダイアログが出ます。
 */
annotate CatalogService.Books with {
  author @Common.ValueList: {
    $Type         : 'Common.ValueListType',
    CollectionPath: 'Authors',
    Parameters    : [
      {
        $Type            : 'Common.ValueListParameterInOut',
        LocalDataProperty: author_ID,
        ValueListProperty: 'ID'
      },
      {
        $Type            : 'Common.ValueListParameterDisplayOnly',
        ValueListProperty: 'name'
      }
    ]
  }
};
