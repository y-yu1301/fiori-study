/*
 * =============================================================================
 * db/schema.cds  ―  データモデル（DBのテーブル設計）の定義
 * -----------------------------------------------------------------------------
 * CAP では「データの形」を .cds という独自言語で書きます。
 * ここに書いた entity(エンティティ) が、そのまま DB のテーブルになります。
 *
 * ★このファイルは CAP Node.js でも CAP Java でも「まったく同じ」書き方です。
 *   言語(JavaScript/Java)に依存しません。現場(CAP Java)でも、この .cds が
 *   そのまま通用する“共通の中核”です。
 *
 * ビルド時(`cds build --for java`)に、CAP がこの定義から
 *   - DBのDDL(schema-h2.sql) … テーブル作成用のSQL
 *   - Javaのクラス(cds.gen パッケージのPOJO) … コードから型安全に扱うため
 * を自動生成します。SQL も Java の入れ物クラスも手書き不要です。
 *
 * 題材は SAP チュートリアル定番の「Bookshop（本屋）」。
 * 本(Books) と 著者(Authors) の2テーブルと、その関連を定義します。
 * =============================================================================
 */

// namespace = このモデルの名前空間（他と名前が衝突しないための接頭辞のようなもの）。
// ここで付けた名前は、サンプルデータの CSV ファイル名にも使われます
//   例: db/data/fiori.study-Books.csv
namespace fiori.study;

// CAP が用意している便利な共通型をインポートします。
// cuid    : 主キー(ID)を自動でUUIDにしてくれる型
// managed : 作成者/作成日時/更新者/更新日時 を自動で持たせてくれる型
using { cuid, managed } from '@sap/cds/common';

/**
 * 本(Books) テーブル
 * `: cuid, managed` と書くことで上記の共通型を「継承」しています。
 * → 自動で ID(UUID) と 作成/更新の記録カラムが付きます。
 */
entity Books : cuid, managed {
  title  : String(111);          // 書名。カッコ内は最大文字数。
  descr  : String(1111);         // 説明文。
  stock  : Integer;              // 在庫数。
  price  : Decimal(9, 2);        // 価格。全9桁・小数2桁。
  availableDate : Date;          // List Report で検索する日付条件のサンプル。

  // author は Authors テーブルへの「関連(多対一)」。
  // 1冊の本は1人の著者に紐づく、という関係を表します。
  // DB上は author_ID という外部キー列になります（CSVでも author_ID で指定）。
  author : Association to Authors;

  // ★サービス間連携用：この本に「関連する映画」の ID。
  //   映画データは別サービス B(MoviesService) が持っており、A はその「ID だけ」を保持します。
  //   ここを Association ではなく“ただの文字列(ID)”にしているのが重要な設計点です：
  //   映画の実体は A のDBに無い（別サービスの所有）ため、DBの外部キーにはできません。
  //   実際の映画データは、A-cap がリモートサービス経由で B から取り寄せます（docs/09参照）。
  relatedMovie_ID : String(36);

  // Object Page に複数行を表示・編集するための関連明細。
  schedules : Composition of many BookSchedules on schedules.book = $self;
}

/**
 * Object Page 内で一括編集する対象行のサンプル。
 * List Report の availableDate 条件を、画面側で businessDate の $filter に変換して渡します。
 */
entity BookSchedules : cuid, managed {
  book         : Association to Books;
  businessDate : Date;
  quantity    : Integer;
  note        : String(255);
}

/**
 * 著者(Authors) テーブル
 */
entity Authors : cuid, managed {
  name  : String(111);           // 著者名。

  // books は Books への「逆方向の関連(一対多)」。
  // 1人の著者は複数の本を持つ、という関係。
  // `on books.author = $self` は「Booksのauthorが自分を指しているものが自分の本」の意味。
  books : Association to many Books on books.author = $self;
}
