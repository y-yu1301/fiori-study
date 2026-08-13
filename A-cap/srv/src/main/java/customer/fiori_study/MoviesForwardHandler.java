package customer.fiori_study;

import com.sap.cds.Result;
import com.sap.cds.services.cds.CdsReadEventContext;
import com.sap.cds.services.cds.CqnService;
import com.sap.cds.services.handler.EventHandler;
import com.sap.cds.services.handler.annotations.On;
import com.sap.cds.services.handler.annotations.ServiceName;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Component;

/**
 * =============================================================================
 * MoviesForwardHandler ― CatalogService.Movies の読み取りを B(MoviesService) へ転送
 * -----------------------------------------------------------------------------
 * 【なぜ必要か】
 *   srv/mashup.cds で `entity Movies as projection on MoviesService.Movies` と
 *   “投影”しただけでは、CAP Java は自動でリモート(B)へ取りに行きません
 *   （その entity は A のDBに実体が無いため、READ しても空になる）。
 *   そこで「Movies の READ が来たら、そのクエリをそのまま B へ転送し、
 *   返ってきた結果を回答にする」ハンドラを1つ書きます。これが連携の“のりしろ”です。
 *
 *   A 経由で B の映画一覧を読む確認や、BooksLinkHandler が映画タイトルを取得するために、
 *   この転送が必要です。
 *
 * 【仕組み】
 *   - @ServiceName("CatalogService")：A の CatalogService 向けのハンドラ。
 *   - @On READ / entity="CatalogService.Movies"：Movies の読み取りイベントに介入。
 *   - moviesService（＝リモートサービス MoviesService）に、受け取った検索クエリ
 *     (context.getCqn()) をそのまま実行 → CAP が裏で B(4005) に HTTP して結果を得る。
 * =============================================================================
 */
@Component
@ServiceName("CatalogService")
public class MoviesForwardHandler implements EventHandler {

    /**
     * リモートサービス MoviesService（application.yaml の cds.remote.services で定義）。
     * 名前(MoviesService)で修飾して注入します。RemoteService は CqnService を実装。
     */
    @Autowired
    @Qualifier("MoviesService")
    private CqnService moviesService;

    @On(event = CqnService.EVENT_READ, entity = "CatalogService.Movies")
    public Result readMovies(CdsReadEventContext context) {
        // 受け取った読み取りクエリを、そのまま B へ転送。
        // これで A 側の Books 一覧に表示する映画タイトルが、B の実データから返る。
        // ★結果は return する（CAP Java はこれで「ON処理が完了した」と判断する）。
        //   void + setResult() だと完了フラグが立たず "No ON handler completed" になる。
        return moviesService.run(context.getCqn());
    }
}
