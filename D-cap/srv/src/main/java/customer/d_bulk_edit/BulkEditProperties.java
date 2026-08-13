package customer.d_bulk_edit;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * application.yaml の <code>bulk-edit:</code> 以下を読み込む設定クラス。
 *
 * <p>
 * 上限値などを Java のコードに直書きせず設定に出しておくと、
 * 「本番では 200 件まで」のような調整がビルドなしでできます。
 * </p>
 *
 * <p>
 * <b>注意：max-items はフロント側の上限（D-ui5/webapp/ext/BulkEditHandler.ts の MAX_ITEMS）と
 * 必ず同じ値にしてください。</b>ずれると、画面では通るのにサーバで弾かれる、という
 * 分かりにくい失敗になります。
 * </p>
 */
@Component
@ConfigurationProperties(prefix = "bulk-edit")
public class BulkEditProperties {

    /** 1つの編集セッションに入れられる最大件数。 */
    private int maxItems = 500;

    /** 未反映セッションを削除するまでの経過時間（時間）。 */
    private int cleanupAfterHours = 24;

    /** 掃除処理の実行間隔（ミリ秒）。 */
    private long cleanupIntervalMs = 3_600_000L;

    public int getMaxItems() {
        return maxItems;
    }

    public void setMaxItems(int maxItems) {
        this.maxItems = maxItems;
    }

    public int getCleanupAfterHours() {
        return cleanupAfterHours;
    }

    public void setCleanupAfterHours(int cleanupAfterHours) {
        this.cleanupAfterHours = cleanupAfterHours;
    }

    public long getCleanupIntervalMs() {
        return cleanupIntervalMs;
    }

    public void setCleanupIntervalMs(long cleanupIntervalMs) {
        this.cleanupIntervalMs = cleanupIntervalMs;
    }
}
