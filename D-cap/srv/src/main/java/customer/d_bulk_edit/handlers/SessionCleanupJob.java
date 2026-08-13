package customer.d_bulk_edit.handlers;

import java.time.Instant;
import java.time.temporal.ChronoUnit;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import com.sap.cds.ql.Delete;
import com.sap.cds.ql.Select;
import com.sap.cds.services.persistence.PersistenceService;
import com.sap.cds.services.runtime.CdsRuntime;
import com.sap.cds.services.runtime.RequestContextRunner;

import customer.d_bulk_edit.BulkEditProperties;

/**
 * 放置された編集セッションを掃除する定期処理。
 *
 * <h2>なぜ必要か</h2>
 * 編集セッションは「作業用の一時データ」です。ユーザーが一括編集を始めたものの
 * 反映せずにブラウザを閉じた場合、セッションと明細（最大500行）がそのまま残ります。
 * 放っておくとゴミが溜まり続けるので、一定時間経った<b>未反映</b>のものを削除します。
 *
 * <h2>削除の条件</h2>
 * <ul>
 * <li>{@code appliedAt} が null（＝まだ反映していない）</li>
 * <li>{@code createdAt} が設定時間（既定24時間）より前</li>
 * </ul>
 * 反映済みのセッションは「いつ何をしたか」の記録として残します
 * （消したい場合は下の条件から appliedAt の判定を外してください）。
 *
 * <h2>Composition の効果</h2>
 * 親（BulkEditSessions）を削除すると、明細（BulkEditItems）も一緒に消えます。
 * Composition が「所有関係」を表しているので、子を明示的に消す必要がありません。
 *
 * <h2>実行間隔</h2>
 * application.yaml の {@code bulk-edit.cleanup-interval-ms}（既定1時間）ごと。
 * 起動から1分後に初回が走ります。
 */
@Component
public class SessionCleanupJob {

    private static final Logger logger = LoggerFactory.getLogger(SessionCleanupJob.class);

    private static final String DB_SESSIONS = "sample.procurement.BulkEditSessions";

    @Autowired
    private PersistenceService db;

    @Autowired
    private BulkEditProperties properties;

    @Autowired
    private CdsRuntime runtime;

    /**
     * 定期実行の入口。
     * <p>
     * ★ポイント：スケジューラのスレッドには「誰がリクエストしたか」という文脈がありません。
     * CAP のクエリは RequestContext の中で動く必要があるため、
     * {@link RequestContextRunner} で内部ユーザーの文脈を作ってから実行します。
     * （これを忘れると実行時に「no request context」で失敗します）
     * </p>
     */
    @Scheduled(initialDelay = 60_000L, fixedDelayString = "${bulk-edit.cleanup-interval-ms:3600000}")
    public void cleanup() {
        runtime.requestContext().systemUser().run(ctx -> {
            deleteStaleSessions();
        });
    }

    private void deleteStaleSessions() {
        Instant threshold = Instant.now().minus(properties.getCleanupAfterHours(), ChronoUnit.HOURS);

        // まず件数を把握（ログに出すため）。件数が不要なら Delete だけでも構いません。
        long stale = db.run(Select.from(DB_SESSIONS)
                .where(s -> s.get("appliedAt").isNull().and(s.get("createdAt").lt(threshold))))
                .rowCount();

        if (stale == 0) {
            return;
        }

        db.run(Delete.from(DB_SESSIONS)
                .where(s -> s.get("appliedAt").isNull().and(s.get("createdAt").lt(threshold))));

        logger.info("未反映のまま {} 時間以上経過した編集セッションを {} 件削除しました。",
                properties.getCleanupAfterHours(), stale);
    }
}
