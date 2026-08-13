package customer.fiori_study;

import cds.gen.moviesservice.Movies;
import cds.gen.moviesservice.Movies_;

import com.sap.cds.CdsData;
import com.sap.cds.services.cds.CqnService;
import com.sap.cds.services.handler.EventHandler;
import com.sap.cds.services.handler.annotations.After;
import com.sap.cds.services.handler.annotations.ServiceName;
import com.sap.cds.services.persistence.PersistenceService;
import com.sap.cds.ql.Select;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Stream;
import java.util.stream.Collectors;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * =============================================================================
 * BooksLinkHandler ― 本一覧に「関連映画」リンク先 URL を足す後処理
 * -----------------------------------------------------------------------------
 * ここでやっているのは「映画データそのものを作る」ことではありません。
 * Books の READ が終わったあとに、各行へ `relatedMovieTitle` と `relatedMovieUrl` を補うだけです。
 *
 * なぜ別ハンドラにするか:
 *   - 本の一覧は A の通常読み取り処理で返す
 *   - 追加の映画タイトルと URL だけを後から埋める
 *   - Books の本来の検索条件やページングを壊しにくい
 *
 * 画面側では `UI.DataFieldWithUrl` を使い、
 *   表示文字 = `relatedMovieTitle`
 *   リンク先 = `relatedMovieUrl`
 * の組み合わせで「タイトルがリンクになる」見え方を作ります。
 *
 * B-ui5 の URL は application.yaml から読みます。
 * 実運用なら destination や approuter のルートに逃がして、環境ごとに切り替えます。
 * =============================================================================
 */
@Component
@ServiceName("CatalogService")
public class BooksLinkHandler implements EventHandler {

    private static final Logger logger = LoggerFactory.getLogger(BooksLinkHandler.class);

    @Value("${app.links.movies-object-page-base-url}")
    private String moviesObjectPageBaseUrl;

    @Autowired
    @Qualifier("MoviesService")
    private CqnService moviesService;

    @Autowired
    private PersistenceService db;

    @After(event = CqnService.EVENT_READ, entity = "CatalogService.Books")
    public void addRelatedMovieUrls(List<CdsData> books) {
        Map<String, String> relatedMovieIdsByBookId = fetchRelatedMovieIdsByBookId(books);
        Map<String, String> relatedMovieIdsByBookTitle = fetchRelatedMovieIdsByBookTitle(books);
        Map<String, String> movieTitlesById = fetchMovieTitlesById(
                relatedMovieIdsByBookId,
                relatedMovieIdsByBookTitle);

        for (CdsData book : books) {
            String bookId = valueAsTrimmedString(book.get("ID"));
            String bookTitle = valueAsTrimmedString(book.get("title"));
            String movieId = valueAsTrimmedString(book.get("relatedMovie_ID"));

            if (movieId == null && bookId != null) {
                movieId = relatedMovieIdsByBookId.get(bookId);
            }
            if (movieId == null && bookTitle != null) {
                movieId = relatedMovieIdsByBookTitle.get(bookTitle);
            }

            // 映画IDが空の本は、関連リンクを出さない。
            if (movieId == null) {
                book.remove("relatedMovieTitle");
                book.remove("relatedMovieUrl");
                continue;
            }

            book.put("relatedMovieTitle", movieTitlesById.get(movieId));

            // FE の Object Page は hash ルーティングで開く。
            // ここでは B-ui5 の Movies 詳細にそのまま飛べる URL を組み立てる。
            book.put("relatedMovieUrl", moviesObjectPageBaseUrl + movieId + ")");
        }
    }

    private Map<String, String> fetchRelatedMovieIdsByBookId(List<CdsData> books) {
        Set<String> bookIds = books.stream()
                .map(book -> book.get("ID"))
                .map(this::valueAsTrimmedString)
                .filter(Objects::nonNull)
                .collect(Collectors.toSet());

        if (bookIds.isEmpty()) {
            return Map.of();
        }

        return db.run(Select.from(cds.gen.fiori.study.Books_.class)
                        .columns(b -> b.ID(), b -> b.relatedMovie_ID())
                        .where(b -> b.ID().in(bookIds)))
                .listOf(cds.gen.fiori.study.Books.class)
                .stream()
                .filter(book -> book.getRelatedMovieId() != null)
                .collect(Collectors.toMap(
                        cds.gen.fiori.study.Books::getId,
                        cds.gen.fiori.study.Books::getRelatedMovieId));
    }

    private Map<String, String> fetchRelatedMovieIdsByBookTitle(List<CdsData> books) {
        Set<String> bookTitles = books.stream()
                .map(book -> book.get("title"))
                .map(this::valueAsTrimmedString)
                .filter(Objects::nonNull)
                .collect(Collectors.toSet());

        if (bookTitles.isEmpty()) {
            return Map.of();
        }

        return db.run(Select.from(cds.gen.fiori.study.Books_.class)
                        .columns(b -> b.title(), b -> b.relatedMovie_ID())
                        .where(b -> b.title().in(bookTitles)))
                .listOf(cds.gen.fiori.study.Books.class)
                .stream()
                .filter(book -> book.getRelatedMovieId() != null)
                .collect(Collectors.toMap(
                        cds.gen.fiori.study.Books::getTitle,
                        cds.gen.fiori.study.Books::getRelatedMovieId,
                        (first, ignored) -> first));
    }

    private Map<String, String> fetchMovieTitlesById(
            Map<String, String> relatedMovieIdsByBookId,
            Map<String, String> relatedMovieIdsByBookTitle) {
        Set<String> movieIds = Stream.concat(
                        relatedMovieIdsByBookId.values().stream(),
                        relatedMovieIdsByBookTitle.values().stream())
                .map(Object::toString)
                .map(String::trim)
                .filter(id -> !id.isEmpty())
                .collect(Collectors.toSet());

        if (movieIds.isEmpty()) {
            return Map.of();
        }

        try {
            return moviesService.run(Select.from(Movies_.class)
                            .columns(m -> m.ID(), m -> m.title())
                            .where(m -> m.ID().in(movieIds)))
                    .listOf(Movies.class)
                    .stream()
                    .collect(Collectors.toMap(Movies::getId, Movies::getTitle));
        } catch (RuntimeException e) {
            logger.warn("Skipping related movie title lookup because MoviesService is unavailable: {}", e.getMessage());
            return Map.of();
        }
    }

    private String valueAsTrimmedString(Object value) {
        if (value == null) {
            return null;
        }

        String text = value.toString().trim();
        return text.isEmpty() ? null : text;
    }
}
