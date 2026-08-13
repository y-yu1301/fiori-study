/*
 * =============================================================================
 * B-cap/srv/movies-service.cds  ―  movies サービス定義＋UIアノテーション
 * -----------------------------------------------------------------------------
 * 起動方法で公開先が変わる点は A と同じ:
 *   - `cd srv && mvn spring-boot:run`（本物のJava）… /odata/v4/MoviesService
 *     （application.yaml で server.port:4005 に固定）
 * フロント(B-ui5)は /odata/v4/MoviesService を OData 越しに参照します。
 *
 * ★A と同様、表示文言は CAP 側の i18n(_i18n/*.properties) に置き、
 *   ここでは {i18n>キー} で参照します（現場と同じ「文言は CAP に一元化」）。
 * =============================================================================
 */
using { movies.catalog as my } from '../db/schema';

service MoviesService {

  // 学習の最初は読み取り専用が安全。編集を試すなら @readonly を外す。
  @readonly
  entity Movies as projection on my.Movies;
}

// --- Fiori Elements 用アノテーション（一覧＝List Report / 詳細＝Object Page） ---
annotate MoviesService.Movies with @(
  UI.LineItem: [
    { Value: title,  Label: '{i18n>movie_title}' },
    { Value: year,   Label: '{i18n>movie_year}' },
    { Value: genre,  Label: '{i18n>movie_genre}' },
    { Value: rating, Label: '{i18n>movie_rating}' }
  ],

  UI.HeaderInfo: {
    TypeName      : '{i18n>movie_typeName}',
    TypeNamePlural: '{i18n>movie_typeNamePlural}',
    Title         : { Value: title }
  },

  UI.FieldGroup #Details: {
    Data: [
      { Value: title,  Label: '{i18n>movie_title}' },
      { Value: year,   Label: '{i18n>movie_year}' },
      { Value: genre,  Label: '{i18n>movie_genre}' },
      { Value: rating, Label: '{i18n>movie_rating}' },
      { Value: descr,  Label: '{i18n>movie_descr}' }
    ]
  },

  UI.Facets: [
    {
      $Type : 'UI.ReferenceFacet',
      Label : '{i18n>facet_details}',
      Target: '@UI.FieldGroup#Details'
    }
  ]
);
