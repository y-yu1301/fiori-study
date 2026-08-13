/*
 * =============================================================================
 * B-cap/db/schema.cds  ―  movies アプリのデータモデル
 * -----------------------------------------------------------------------------
 * B アプリは A(bookshop) とは無関係の別ドメイン「映画カタログ」です。
 * DB も別（B-cap 専用の H2）。これで「アプリごとに独立」を体現します。
 *
 * 書き方は A と同じ CDS。CAP Node.js / Java 共通で言語非依存です。
 * =============================================================================
 */
namespace movies.catalog;

using { cuid, managed } from '@sap/cds/common';

/**
 * 映画(Movies) テーブル
 */
entity Movies : cuid, managed {
  title  : String(200);          // 作品名
  year   : Integer;              // 公開年
  genre  : String(50);           // ジャンル
  rating : Decimal(2, 1);        // 評価（0.0〜9.9 想定）
  descr  : String(1000);         // あらすじ
}
