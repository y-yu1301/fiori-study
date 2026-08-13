/*
 * =============================================================================
 * A-cap/srv/mashup.cds  ―  サービス間連携（A が B のデータを取り込む）
 * -----------------------------------------------------------------------------
 * ここは「A 本来の機能(cat-service.cds)」とは分けて、B との連携だけを書く場所です。
 * 見通しのため専用ファイルにしています。
 *
 * 【今の段階＝一覧リンク用の連携定義】
 *   B(MoviesService) の Movies を、A のサービス CatalogService に「読み取り投影」して
 *   公開します。これにより A 側の Books から、B 側の映画タイトルを参照できます。
 *   まずは次の URL で “A 経由で B の映画” が取れることを確認します:
 *     http://localhost:4004/odata/v4/CatalogService/Movies
 *
 *   そのうえで Books に `relatedMovie` と `relatedMovieUrl` を足し、
 *   一覧の「関連情報」列から B 側の Object Page へ飛ばします。
 * =============================================================================
 */
using { CatalogService } from './cat-service';
using { MoviesService as ext } from './external/MoviesService';

extend service CatalogService with {
  // B の Movies を、A のサービスの一部として読み取り公開。
  // 実データは A のDBに無く、リモートサービス経由で B から取得されます。
  @readonly
  entity Movies as projection on ext.Movies;
}

// -----------------------------------------------------------------------------
// Book → 関連映画（relatedMovie）の「関連(association)」。
// これで Books の1行に「どの映画にひも付くか」を OData 上の navigation として
// 持たせられる。画面では `relatedMovieTitle` を文字表示に使い、
// `relatedMovieUrl` をクリック先に使う。
// -----------------------------------------------------------------------------
// ★注意：extend projection は投影列の追加なので、要素を複数並べるときは `,` で区切る。
//   DB由来ではない新規項目は `virtual null as ...` で select item として追加する。
extend projection CatalogService.Books with {
  relatedMovie : Association to CatalogService.Movies
                   on relatedMovie.ID = relatedMovie_ID,
  // 画面専用の非永続カラム。B から取った映画タイトルを後処理で埋める。
  virtual null as relatedMovieTitle : String(200),
  // 画面専用の非永続カラム。DB に保存する値ではなく、後処理で埋める。
  virtual null as relatedMovieUrl : String(500)
}
