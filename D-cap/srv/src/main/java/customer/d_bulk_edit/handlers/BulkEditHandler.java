package customer.d_bulk_edit.handlers;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import com.sap.cds.Row;
import com.sap.cds.ql.CQL;
import com.sap.cds.ql.Insert;
import com.sap.cds.ql.Predicate;
import com.sap.cds.ql.Select;
import com.sap.cds.ql.Update;
import com.sap.cds.ql.cqn.AnalysisResult;
import com.sap.cds.ql.cqn.CqnAnalyzer;
import com.sap.cds.services.ErrorStatuses;
import com.sap.cds.services.ServiceException;
import com.sap.cds.services.cds.CqnService;
import com.sap.cds.services.handler.EventHandler;
import com.sap.cds.services.handler.annotations.After;
import com.sap.cds.services.handler.annotations.On;
import com.sap.cds.services.handler.annotations.ServiceName;
import com.sap.cds.services.messages.Messages;
import com.sap.cds.services.persistence.PersistenceService;

import cds.gen.bulkeditservice.SessionsDraftActivateContext;
import cds.gen.bulkeditservice.PrepareBulkEditContext;
import cds.gen.bulkeditservice.Sessions;
import customer.d_bulk_edit.BulkEditProperties;

/**
 * アプリDの中核。「絞り込み結果の全件をまとめて編集する」ための2つのアクションを実装します。
 *
 * <h2>1. prepareBulkEdit（入口）</h2>
 *
 * <pre>
 *   List Report「まとめて編集」
 *     → criteria(JSON) と search を受け取る
 *     → CriteriaTranslator で検証＆CQN へ変換
 *     → 対象の PurchaseRequests を検索
 *     → 0件／上限超過なら即エラー
 *     → BulkEditSessions を1件 + 対象行のコピーを BulkEditItems へ INSERT
 *     → 作った Sessions を返す（Fiori Elements がその Object Page へ自動遷移）
 * </pre>
 *
 * <h2>2. 保存（draftActivate）＝ 元データへの書き戻し（出口）</h2>
 *
 * <pre>
 *   Object Page「保存」
 *     → Draft が確定した直後に、この After ハンドラが動く
 *     → セッション配下の明細を全部読む
 *     → 行ごとに (a) 競合検知 (b) 業務チェック
 *     → 問題ない行だけ元テーブルへ UPDATE
 *     → 行ごとの結果を applyStatus / applyMessage に残す（部分成功を許容）
 * </pre>
 *
 * <h2>この実装が守っていること</h2>
 * <ul>
 * <li>条件を受け取るのは prepareBulkEdit の1回だけ。以降のリクエストでは条件を運ばない。</li>
 * <li>条件が解釈できなければ 400 で止める。「とりあえず全件」のようなフォールバックはしない。</li>
 * <li>明細は元レコードの<b>コピー</b>。元データの Draft と衝突しない。</li>
 * <li>反映は全件ロールバックにせず、行ごとに成否を残す。</li>
 * </ul>
 */
@Component
@ServiceName("BulkEditService")
public class BulkEditHandler implements EventHandler {

    private static final Logger logger = LoggerFactory.getLogger(BulkEditHandler.class);

    /** CQN で使う実体名（DB のエンティティ）。書き込みはこちらに対して行います。 */
    private static final String DB_PURCHASE_REQUESTS = "sample.procurement.PurchaseRequests";
    private static final String DB_SESSIONS = "sample.procurement.BulkEditSessions";
    private static final String DB_ITEMS = "sample.procurement.BulkEditItems";

    /** サービス側の実体名。読み取りはこちら（＝ユーザーの権限が効く経路）を通します。 */
    private static final String SRV_PURCHASE_REQUESTS = "BulkEditService.PurchaseRequests";

    /** 明細の反映結果。画面では applyStatus 列に出ます。 */
    private static final String PENDING = "PENDING";
    private static final String APPLIED = "APPLIED";
    private static final String UNCHANGED = "UNCHANGED";
    private static final String CONFLICT = "CONFLICT";
    private static final String ERROR = "ERROR";

    /** UI.Criticality の値：0=中立 1=赤 2=黄 3=緑 */
    private static final int CRIT_NEUTRAL = 0;
    private static final int CRIT_NEGATIVE = 1;
    private static final int CRIT_CRITICAL = 2;
    private static final int CRIT_POSITIVE = 3;

    private static final DateTimeFormatter DESC_TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");

    @Autowired
    private PersistenceService db;

    @Autowired
    private CriteriaTranslator criteriaTranslator;

    @Autowired
    private BulkEditProperties properties;

    @Autowired
    private Messages messages;

    // =========================================================================
    // 1. prepareBulkEdit ― 絞り込み条件から編集セッションを作る
    // =========================================================================
    @On(event = PrepareBulkEditContext.CDS_NAME)
    public void prepareBulkEdit(PrepareBulkEditContext context) {

        String criteriaJson = context.getCriteria();
        String search = context.getSearch();
        String user = context.getUserInfo().getName();

        logger.debug("prepareBulkEdit: user={}, criteria={}, search={}", user, criteriaJson, search);

        // --- (1) 条件の検証と CQN への変換 -----------------------------------
        // 不正な項目・演算子はここで 400 になります（例外は握りつぶしません）。
        Optional<Predicate> filterPredicate = criteriaTranslator.translate(criteriaJson);

        // --- (2) 対象を検索する ----------------------------------------------
        // ★サービス（BulkEditService）経由で読みます。
        //   PersistenceService を直接使うと @restrict などの権限設定を素通りしてしまい、
        //   「画面では見えない行まで一括編集の対象になる」事故が起きうるためです。
        Select<?> select = Select.from(SRV_PURCHASE_REQUESTS);
        if (filterPredicate.isPresent()) {
            select = select.where(filterPredicate.get());
        }

        // フリーテキスト検索は CQN の search() に任せます。
        // これは画面のフィルタバー右上の検索と同じ仕組み（$search）で、
        // 対象項目は srv/annotations.cds の @cds.search で決まります。
        // 自分で「項目A contains 語 or 項目B contains 語」と書くこともできますが、
        // それだと大文字小文字の扱いなどが画面の検索とずれてしまいます。
        if (search != null && !search.isBlank()) {
            select = select.search(search.trim());
        }

        select = select.orderBy(CQL.get("requestNo").asc());

        // 上限チェックのために「上限+1件」だけ取ります。
        // 全件を数えてから取り直すより1往復で済み、巨大な結果でメモリを食いません。
        int maxItems = properties.getMaxItems();
        CqnService service = (CqnService) context.getService();
        List<Row> rows = service.run(select.limit(maxItems + 1)).list();

        // --- (3) 件数のチェック ----------------------------------------------
        if (rows.isEmpty()) {
            throw new ServiceException(ErrorStatuses.BAD_REQUEST,
                    "絞り込み結果が0件です。条件を見直してください。");
        }
        if (rows.size() > maxItems) {
            throw new ServiceException(ErrorStatuses.BAD_REQUEST,
                    "対象が多すぎます（上限 " + maxItems + " 件）。絞り込み条件を追加してください。");
        }

        // --- (4) セッション＋明細を組み立てる --------------------------------
        String sessionId = UUID.randomUUID().toString();
        Instant now = now();

        List<Map<String, Object>> items = new ArrayList<>(rows.size());
        for (Row row : rows) {
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("ID", UUID.randomUUID().toString());
            item.put("parent_ID", sessionId);

            // 書き戻し先の識別子と、競合検知のための「読んだ時点の更新日時」。
            // この2つが無いと、あとで安全に書き戻せません。
            item.put("sourceID", row.get("ID"));
            item.put("sourceModifiedAt", row.get("modifiedAt"));

            // 表示専用のコピー（元レコードを参照せず値を持つ ＝ 元の Draft と衝突しない）
            item.put("requestNo", row.get("requestNo"));
            item.put("title", row.get("title"));
            item.put("department", row.get("department"));
            item.put("status", row.get("status"));

            // 編集対象の初期値（＝現在値）
            item.put("quantity", row.get("quantity"));
            item.put("unitPrice", row.get("unitPrice"));
            item.put("remark", row.get("remark"));

            item.put("applyStatus", PENDING);
            item.put("applyMessage", null);
            item.put("applyCriticality", CRIT_NEUTRAL);

            items.add(item);
        }

        Map<String, Object> session = new LinkedHashMap<>();
        session.put("ID", sessionId);
        session.put("description", String.format("絞り込み結果 %d件（%s）",
                items.size(), LocalDateTime.ofInstant(now, ZoneId.systemDefault()).format(DESC_TIME)));
        session.put("itemCount", items.size());
        // 条件は「記録」として保存するだけ。ここから読み直して再検索することはありません。
        session.put("criteria", criteriaJson);
        session.put("appliedAt", null);
        // PersistenceService へ直接書くと managed の自動セットが効かないため、明示的に入れます。
        session.put("createdAt", now);
        session.put("createdBy", user);
        session.put("modifiedAt", now);
        session.put("modifiedBy", user);
        // Composition なので、親と子を1回の INSERT でまとめて登録できます（deep insert）。
        session.put("items", items);

        // ★Draft 有効エンティティですが、ここでは PersistenceService に対して書きます。
        //   サービス経由だと「まず Draft を作る」流れを通ることになり、
        //   FE の遷移先（アクティブなインスタンス）とずれるためです。
        db.run(Insert.into(DB_SESSIONS).entry(session));

        logger.info("prepareBulkEdit: セッション {} を作成しました（{}件, user={}）",
                sessionId, items.size(), user);

        // --- (5) 作ったセッションを返す ---------------------------------------
        // FE は返却された「キー」を見て Object Page へ遷移します（requiresNavigation: true）。
        // Draft 有効エンティティのキーは ID と IsActiveEntity の2つなので、両方入れます。
        context.setResult(toActiveSession(sessionId));
        context.setCompleted();
    }

    // =========================================================================
    // 2. 保存（draftActivate）の直後に、明細を元の購買申請へ書き戻す
    // =========================================================================
    /**
     * Object Page の「保存」を押すと、CAP は Draft を確定（draftActivate）します。
     * その<b>直後</b>にこのハンドラが動き、明細の内容を元の購買申請へ書き戻します。
     *
     * <p>
     * ★「保存」と「反映」を分けない理由：
     * ユーザーから見れば保存したのに元データが変わらない状態は理解しにくく、
     * 反映を押し忘れたまま離脱する事故が起きます。
     * 保存＝反映にまとめることで、押し忘れという失敗そのものを無くしています。
     * </p>
     *
     * <p>
     * {@code @After} なので、Draft の確定に成功したときだけ動きます。
     * 書き戻しは行単位で成否を記録し、途中で失敗しても他の行は進めます（部分成功）。
     * </p>
     */
    @After(event = SessionsDraftActivateContext.CDS_NAME, entity = "BulkEditService.Sessions")
    public void applyOnSave(SessionsDraftActivateContext context) {

        String user = context.getUserInfo().getName();

        // --- (1) 対象セッションのキーを取り出す --------------------------------
        // 保存された Draft がどのセッションだったかは、リクエストの CQN に入っています。
        // CqnAnalyzer はそこからキーを抜き出す標準の道具です。
        AnalysisResult analysis = CqnAnalyzer.create(context.getModel()).analyze(context.getCqn().ref());
        String sessionId = String.valueOf(analysis.targetKeys().get("ID"));

        // --- (2) セッションの存在と所有者を確認 -------------------------------
        Row session = db.run(Select.from(DB_SESSIONS).where(s -> s.get("ID").eq(sessionId)))
                .first()
                .orElseThrow(() -> new ServiceException(ErrorStatuses.NOT_FOUND,
                        "編集セッションが見つかりません: " + sessionId));

        // CDS 側の @restrict でも守られていますが、
        // 「サービス経由以外で呼ばれても守る」ためにハンドラでも明示的に確認します（多層防御）。
        String owner = (String) session.get("createdBy");
        if (owner != null && !owner.equals(user)) {
            throw new ServiceException(ErrorStatuses.FORBIDDEN,
                    "他のユーザーが作成した編集セッションは保存できません。");
        }

        // --- (3) 明細を全部読む ------------------------------------------------
        List<Row> items = db.run(Select.from(DB_ITEMS)
                .where(i -> i.get("parent_ID").eq(sessionId))
                .orderBy(CQL.get("requestNo").asc())).list();

        int applied = 0;
        int unchanged = 0;
        int conflicted = 0;
        int failed = 0;
        Instant now = now();

        for (Row item : items) {
            String itemId = (String) item.get("ID");
            Object sourceId = item.get("sourceID");

            // --- (3-a) 元レコードを取得 ---------------------------------------
            Optional<Row> sourceOpt = db.run(
                    Select.from(DB_PURCHASE_REQUESTS).where(p -> p.get("ID").eq(sourceId))).first();

            if (sourceOpt.isEmpty()) {
                markItem(itemId, ERROR, CRIT_NEGATIVE, "元の購買申請が削除されています。");
                failed++;
                continue;
            }
            Row source = sourceOpt.get();

            // --- (3-b) 競合検知（楽観ロック）-----------------------------------
            // セッション作成時に控えた modifiedAt と、いまの modifiedAt が違えば、
            // 別の誰か（または別セッション）が先に更新したということ。上書きせず飛ばします。
            Object expected = item.get("sourceModifiedAt");
            Object actual = source.get("modifiedAt");
            if (!Objects.equals(expected, actual)) {
                markItem(itemId, CONFLICT, CRIT_CRITICAL,
                        "他の更新と競合したため反映していません（更新日時: " + actual + "）。");
                conflicted++;
                continue;
            }

            // --- (3-c) 業務チェック --------------------------------------------
            // ★業務ルールを足したいときはこのメソッドに書き足します。
            String violation = validate(item);
            if (violation != null) {
                markItem(itemId, ERROR, CRIT_NEGATIVE, violation);
                failed++;
                continue;
            }

            // --- (3-d) 値が変わっていない行は触らない ---------------------------
            // 保存のたびに全行を UPDATE すると、編集していないレコードの modifiedAt まで
            // 動いてしまい、他の人の編集セッションが不要に競合します。
            if (isUnchanged(item, source)) {
                markItem(itemId, UNCHANGED, CRIT_NEUTRAL, "変更がないため更新していません。");
                unchanged++;
                continue;
            }

            // --- (3-e) 元テーブルへ反映 ----------------------------------------
            Map<String, Object> update = new LinkedHashMap<>();
            update.put("ID", sourceId);
            update.put("quantity", item.get("quantity"));
            update.put("unitPrice", item.get("unitPrice"));
            update.put("remark", item.get("remark"));
            // PersistenceService 経由なので managed の自動更新は効きません。手で入れます。
            update.put("modifiedAt", now);
            update.put("modifiedBy", user);
            db.run(Update.entity(DB_PURCHASE_REQUESTS).entry(update));

            // 反映済みの行は、控えの更新日時も now に更新しておきます。
            // こうしておくと「もう一度反映」を押しても自分自身とは競合しません。
            Map<String, Object> itemUpdate = new LinkedHashMap<>();
            itemUpdate.put("ID", itemId);
            itemUpdate.put("sourceModifiedAt", now);
            itemUpdate.put("applyStatus", APPLIED);
            itemUpdate.put("applyMessage", "購買申請へ反映しました。");
            itemUpdate.put("applyCriticality", CRIT_POSITIVE);
            db.run(Update.entity(DB_ITEMS).entry(itemUpdate));
            applied++;
        }

        // --- (4) セッションに反映日時を記録 -------------------------------------
        Map<String, Object> sessionUpdate = new LinkedHashMap<>();
        sessionUpdate.put("ID", sessionId);
        sessionUpdate.put("appliedAt", now);
        sessionUpdate.put("modifiedAt", now);
        sessionUpdate.put("modifiedBy", user);
        db.run(Update.entity(DB_SESSIONS).entry(sessionUpdate));

        // --- (5) 結果サマリを画面のメッセージとして返す --------------------------
        // 部分成功を許容する設計なので、「何件通って何件通らなかったか」を必ず伝えます。
        // このメッセージは「保存」の応答に乗るので、保存直後に画面へ表示されます。
        String summary = String.format(
                "購買申請へ反映しました: 更新 %d件 / 変更なし %d件 / 競合 %d件 / エラー %d件",
                applied, unchanged, conflicted, failed);
        if (conflicted == 0 && failed == 0) {
            messages.success(summary);
        } else {
            messages.warn(summary + "。競合・エラーの行は明細の「反映結果」列を確認してください。");
        }
        logger.info("applyOnSave: session={}, {}", sessionId, summary);
    }

    // =========================================================================
    // ここから下は補助メソッド
    // =========================================================================

    /**
     * 保存済みのセッションを読み直して、アクション戻り値の形（Sessions）に詰めます。
     * <p>
     * FE の遷移に必要なのはキー（ID と IsActiveEntity）だけですが、
     * 中身も返しておくと、curl などで叩いたときに結果が分かりやすくなります。
     * </p>
     */
    private Sessions toActiveSession(String sessionId) {
        Sessions result = Sessions.create();
        db.run(Select.from(DB_SESSIONS).where(s -> s.get("ID").eq(sessionId)))
                .first()
                .ifPresent(result::putAll);
        result.setId(sessionId);
        // Draft 有効エンティティの2つ目のキー。これが無いと FE が遷移先を決められません。
        result.put("IsActiveEntity", true);
        return result;
    }

    /**
     * 明細の編集対象3項目が、元レコードの現在値と同じかどうか。
     * <p>
     * 同じなら書き戻す必要がありません。BigDecimal は {@code equals} だと
     * スケール違い（10 と 10.00）を別物と判定してしまうため {@code compareTo} で比べます。
     * </p>
     */
    private boolean isUnchanged(Row item, Row source) {
        return Objects.equals(item.get("quantity"), source.get("quantity"))
                && sameDecimal(item.get("unitPrice"), source.get("unitPrice"))
                && Objects.equals(item.get("remark"), source.get("remark"));
    }

    private boolean sameDecimal(Object a, Object b) {
        if (a instanceof BigDecimal x && b instanceof BigDecimal y) {
            return x.compareTo(y) == 0;
        }
        return Objects.equals(a, b);
    }

    /**
     * 明細1行の業務チェック。
     * <p>
     * ★業務ルールを増やす場所はここです。問題があればメッセージを、無ければ null を返します。
     * </p>
     */
    private String validate(Row item) {
        Object quantity = item.get("quantity");
        if (!(quantity instanceof Number n) || n.intValue() < 1) {
            return "数量は1以上で入力してください。";
        }
        Object unitPrice = item.get("unitPrice");
        if (!(unitPrice instanceof BigDecimal price) || price.compareTo(BigDecimal.ZERO) <= 0) {
            return "単価は0より大きい値で入力してください。";
        }
        return null;
    }

    /** 明細1行に反映結果を書き込みます。 */
    private void markItem(String itemId, String status, int criticality, String message) {
        Map<String, Object> update = new LinkedHashMap<>();
        update.put("ID", itemId);
        update.put("applyStatus", status);
        update.put("applyCriticality", criticality);
        update.put("applyMessage", message);
        db.run(Update.entity(DB_ITEMS).entry(update));
    }

    /**
     * 現在時刻（ミリ秒に丸め）。
     * <p>
     * ナノ秒まで持つと DB の精度との差で「保存した値と読み直した値が一致しない」ことがあり、
     * 競合検知が誤作動します。書き込む時刻は必ずここを通します。
     * </p>
     */
    private static Instant now() {
        return Instant.now().truncatedTo(ChronoUnit.MILLIS);
    }
}
