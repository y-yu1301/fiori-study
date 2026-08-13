package customer.d_bulk_edit;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * アプリD の起動クラス。
 *
 * <p>
 * {@code @EnableScheduling} は、放置された編集セッションを定期的に掃除する
 * {@link customer.d_bulk_edit.handlers.SessionCleanupJob} を動かすために必要です。
 * </p>
 *
 * <pre>
 * 起動:  cd D-cap/srv &amp;&amp; mvn spring-boot:run
 * 確認:  http://localhost:4007/odata/v4/BulkEditService/PurchaseRequests
 * </pre>
 */
@SpringBootApplication
@EnableScheduling
public class Application {

    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
