package customer.f_retry_edit;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sap.cds.CdsData;
import com.sap.cds.Result;
import com.sap.cds.ql.Select;
import com.sap.cds.services.cds.CdsReadEventContext;
import com.sap.cds.services.cds.CqnService;
import com.sap.cds.services.handler.EventHandler;
import com.sap.cds.services.handler.annotations.After;
import com.sap.cds.services.handler.annotations.Before;
import com.sap.cds.services.handler.annotations.On;
import com.sap.cds.services.handler.annotations.ServiceName;
import com.sap.cds.services.persistence.PersistenceService;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;

/**
 * Fは、現場で使われている「HTTP HeaderとOData Filterの二経路」を意図的に再現します。
 *
 * <p>優先順位は次のとおりです。</p>
 * <ol>
 *   <li>X-Search-Conditionが届いた場合はHeaderからWHEREを作り直す</li>
 *   <li>Headerがない場合は、UI5が送ったOData $filterをそのまま利用する</li>
 * </ol>
 *
 * <p>この方式には条件の二重管理と通信タイミング依存があります。Fはそれを解消する
 * 設計例ではなく、リトライと再読込によって既存方式を動かす比較用サンプルです。</p>
 *
 * <h2>どのハンドラが、どのリクエストで、何を詰めるのか</h2>
 *
 * <pre>
 *  画面                     リクエスト                          このクラスのメソッド
 *  ─────────────────────────────────────────────────────────────────────────────
 *  List Report 一覧      GET /WorkItems?$filter=...          afterReadWorkItems ★注意1
 *  Object Page ヘッダー  GET /WorkItems(key)                 afterReadWorkItems
 *  Object Page 明細      GET /WorkItems(key)/bulkEditItems   onReadBulkItems
 *  明細の行編集          PATCH /WorkItemBulkItems(key)       beforeUpdateBulkItem
 *  保存(Draft Activate)  PATCH /WorkItems(key,false) 相当    beforeUpdateWorkItemRoot
 * </pre>
 *
 * <h3>★注意1：afterReadWorkItems は List Report の一覧READでも発火します</h3>
 * <p>
 * ハンドラの登録単位はエンティティなので、Object Page のルートREADだけでなく
 * 一覧READにも入ります。Frontend はヘッダーを設定したあと削除しないため、
 * 一度 Object Page を開いた後に一覧へ戻って再検索すると、
 * <b>前回の条件のヘッダー</b>が付いた一覧READが飛び、各行に古い virtual 値が入ります。
 * 一覧では virtual 項目を表示していないので画面上は無害ですが、
 * その値は ODataModel のキャッシュに残り、
 * Object Page がその行Contextを引き継いだ場合にヘッダー表示が古くなる原因になります。
 * </p>
 *
 * <h3>★注意2：virtual 項目は DB のレコードではありません</h3>
 * <p>
 * {@code searchLocation / searchPeriod / searchStatus} は
 * {@code db/schema.cds} で {@code virtual} と宣言してあり、DB列が存在しません。
 * 値はリクエストごとに {@link #afterReadWorkItems} が {@code row.put(...)} で
 * レスポンスへ載せているだけです。したがって
 * </p>
 * <ul>
 *   <li>「保存」しても書き戻る先が無い（{@code EDITABLE_FIELDS} に含めていません）</li>
 *   <li>ヘッダーが届かないREADでは、単に空になる（前回値が残るのではなく詰められない）</li>
 *   <li>逆に、キャッシュから返されたレスポンスには<b>前回詰めた値</b>が残る</li>
 * </ul>
 *
 * <h3>★注意3：ヘッダー経路と $filter 経路の非対称</h3>
 * <p>
 * OData V4 モデルのキャッシュキーは「リソースパス＋クエリオプション」です。
 * {@code $filter} はキーに入りますが HTTP Header は入りません。
 * そのため <b>明細（$filter経路）は条件が変われば必ず読み直され、
 * ヘッダー（Header経路）は読み直されないことがあります</b>。
 * 「明細は正しいのにヘッダーだけ古い／空」という症状はこの非対称から生じます。
 * Frontend の {@code requestRefresh()} はその救済であり、解決ではありません。
 * </p>
 */
@Component
@ServiceName("WorkItemService")
public class WorkItemsHandler implements EventHandler {

    private static final Logger logger = LoggerFactory.getLogger(WorkItemsHandler.class);
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SEARCH_CONDITION_HEADER = "x-search-condition";
    private static final List<String> EDITABLE_FIELDS = List.of(
            "name",
            "location",
            "businessDate",
            "status",
            "assignee",
            "plannedQuantity",
            "actualQuantity",
            "comment");

    @Autowired
    private PersistenceService db;

    /**
     * <b>明細側の集合を決める場所です。</b>
     *
     * <p>Object Page本文テーブルのNavigationを、検索結果一覧用Entity Setへ差し替えます。</p>
     *
     * <p>HeaderがあるときはHeaderを優先し、受信した$filterの業務条件を置き換えます。
     * Headerがないときはwhereを変更しないため、beforeRebindTableで追加した$filterが
     * フォールバックとして働きます。</p>
     *
     * <p>
     * ★{@code @On} で自前実行しているのは、受信CQNの {@code from} を差し替える必要が
     * あるためです。標準のままだと Navigation の制約により「選択した1行」しか返りません。
     * ヘッダー側（{@link #afterReadWorkItems}）が {@code @After} で表示値を足すだけなのと
     * 対照的に、こちらはクエリそのものを組み替えます。
     * </p>
     *
     * <p>
     * ★{@code orderBy / limit / columns} は受信CQNのまま残します。
     * 画面の並べ替え・ページングは標準に任せ、差し替えるのは
     * 「どのEntity Setを読むか」と「業務のWHERE」だけに限定しています。
     * </p>
     */
    @On(event = CqnService.EVENT_READ, entity = "WorkItemService.WorkItemBulkItems")
    public Result onReadBulkItems(CdsReadEventContext context) {
        // ★デバッグの起点：加工前の受信CQN（＝UI5が送った $filter がそのまま入っている）
        //   ここに beforeRebindTable で足した条件が見えるかどうかで、
        //   Frontend側の追加が届いているかを判定できます。
        logger.debug("[F-DEBUG] 明細READ 加工前CQN: {}", context.getCqn());

        Optional<SearchCondition> headerCondition = readSearchCondition(context);
        String rewrittenCqn = rewriteBulkItemsQuery(context, headerCondition);

        if (headerCondition.isPresent()) {
            logger.info("WorkItemBulkItems READ source=HEADER condition={}", headerCondition.get());
        } else {
            logger.info("WorkItemBulkItems READ source=ODATA_FILTER");
        }
        logger.debug("Rewritten bulk-items CQN: {}", rewrittenCqn);

        // FEの一覧は$count=trueを使用するため、独自実行でもinlineCountを返します。
        Result result = db.run(Select.cqn(rewrittenCqn).inlineCount());

        // ★加工後に実際に返した件数。画面の表示件数と一致するかを突き合わせます。
        //   一覧の件数と違う場合、条件の変換（Header または $filter）でズレています。
        logger.info("[F-DEBUG] 明細READ 返却件数={}", result.rowCount());
        return result;
    }

    /**
     * <b>ヘッダー側の表示値を詰める唯一の場所です。</b>
     *
     * <p>Object Pageルートは、選択された1行を標準Navigationのキーで取得します。
     * Headerが付かずに最初のREADが走った場合、virtual項目は空のままです。
     * FrontendがHeader設定に成功した後でルートContextをrefreshし、このAfter READを
     * もう一度実行させるのがFの再表示処理です。</p>
     *
     * <p>
     * {@code @After} にしているのは、DBから読んだ行に「表示専用の値を足す」処理だからです。
     * WHERE やキーには一切関与しません（＝選択行の取得は完全に標準のまま）。
     * </p>
     *
     * <p>
     * ★ヘッダーが無いときに<b>何もしない</b>のは意図的です。
     * 「前回の条件を覚えておいて代わりに使う」ような後始末をサーバ側に入れると、
     * 画面に表示されている条件と実際に編集している集合がずれても気づけなくなります。
     * 詰められなかったこと（＝空表示）を、そのまま症状として見せています。
     * </p>
     *
     * <p>
     * ★このメソッドは一覧READでも走ります（クラスJavadocの注意1）。
     * {@code rows} が一覧の全行になるため、条件の値が全行へ同じように入ります。
     * 表示していないので害はありませんが、キャッシュには残ります。
     * </p>
     */
    @After(event = CqnService.EVENT_READ, entity = "WorkItemService.WorkItems")
    public void afterReadWorkItems(CdsReadEventContext context, List<CdsData> rows) {
        Optional<SearchCondition> condition = readSearchCondition(context);

        // ★ここが「ヘッダーが届いたかどうか」を判定する決定的なログです。
        //   Frontend のコンソールに "Header setup succeeded" が出ていても、
        //   このログが present=false なら、そのREADはヘッダー設定より前に飛んでいます
        //   （＝リトライが間に合っていない）。両方のログを時刻で並べて確認してください。
        //
        //   rows.size() が1件ならObject Pageのルートread、複数なら一覧readです
        //   （一覧readでも発火する点はクラスJavadocの注意1を参照）。
        logger.info("[F-DEBUG] WorkItems READ header={} rows={} cqn={}",
                condition.isPresent() ? "あり" : "なし（virtual項目は空になります）",
                rows.size(), context.getCqn());

        // ヘッダーが無ければ ifPresent の中は実行されません（virtual項目は空のまま）。
        condition.ifPresent(value -> rows.forEach(row -> {
            // 加工前：ヘッダーから復元したDTO／加工後：画面へ表示する文字列
            String location = display(value.location(), "未指定");
            String period = value.periodText();
            String status = display(value.status(), "未指定");
            logger.debug("[F-DEBUG] virtual項目を詰めます id={} location={} period={} status={}",
                    row.get("ID"), location, period, status);

            row.put("searchLocation", location);
            row.put("searchPeriod", period);
            row.put("searchStatus", status);
        }));
    }

    /**
     * 明細テーブルで編集された行は、Draftを経由せず<b>Active行への通常のUPDATE</b>として
     * ここへ到達します（{@code WorkItemBulkItems} は非Draft投影のため）。
     *
     * <p>保存時のイベント順序は次のとおりです。</p>
     * <ol>
     *   <li>明細の行編集 … PATCH /WorkItemBulkItems(key) → このメソッド（＝即座にActiveへ反映）</li>
     *   <li>「保存」 … Draft Activate → {@link #beforeUpdateWorkItemRoot}</li>
     * </ol>
     *
     * <p>1が先に確定してしまうため、2でルートのDraft値がActiveを上書きしないよう
     * 同期処理が必要になります。詳細は {@link #beforeUpdateWorkItemRoot} を参照してください。</p>
     */
    @Before(event = CqnService.EVENT_UPDATE, entity = "WorkItemService.WorkItemBulkItems")
    public void beforeUpdateBulkItem(CdsData row) {
        // Object Pageで変更された各行は通常のUPDATEとしてここへ到達します。
        logger.info("WorkItemBulkItems UPDATE: {}", row);
    }

    /**
     * Object Pageの保存時、CAP Draftは選択行の古いDraft値をActiveへ書き戻します。
     * 一方、本文TableのWorkItemBulkItemsは同じDBテーブルのActive行を直接更新します。
     * そのままActivateすると、本文Tableで変更した選択行だけが古い値へ戻ります。
     *
     * <p>Draft Activate内部では、IsActiveEntity=falseのWorkItems UPDATEが発生します。
     * その直前に同じIDのActive行を読み、Tableで更新可能な項目をDraft側の更新データへ
     * コピーします。これにより、選択行を含むすべてのTable更新を保持します。</p>
     */
    @Before(event = CqnService.EVENT_UPDATE, entity = "WorkItemService.WorkItems")
    public void beforeUpdateWorkItemRoot(CdsData draftRootRow) {
        if (!Boolean.FALSE.equals(draftRootRow.get("IsActiveEntity"))) {
            return;
        }

        String id = valueAsString(draftRootRow.get("ID"));
        if (id == null) {
            return;
        }

        db.run(Select.from(cds.gen.f.retry.edit.WorkItems_.class)
                .where(item -> item.ID().eq(id)))
                .listOf(cds.gen.f.retry.edit.WorkItems.class)
                .stream()
                .findFirst()
                .ifPresent(activeRow -> {
                    // ★加工前後を並べて出します。
                    //   before = Draftが持っている（＝古い可能性のある）値
                    //   after  = 明細テーブルの更新で確定しているActive側の値
                    //   保存後に値が巻き戻る症状が出たときは、この2つを比較してください。
                    EDITABLE_FIELDS.forEach(field -> logger.debug(
                            "[F-DEBUG] Draft同期 {} : before={} after={}",
                            field, draftRootRow.get(field), activeRow.get(field)));

                    EDITABLE_FIELDS.forEach(field -> draftRootRow.put(field, activeRow.get(field)));
                    logger.info("WorkItems draft root synced from active bulk-edit row before activation: {}", id);
                });
    }

    private String valueAsString(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    /**
     * HTTP Headerをデコードし、Frontendと共通の小さなDTOへ変換します。
     *
     * <p>
     * {@code context.getParameterInfo()} が、そのリクエストのHTTPヘッダー・クエリ等の
     * 「通信の付帯情報」を持っています。ヘッダー名の判定は大文字小文字を区別しないため、
     * 定数は小文字で持っています（Frontendは {@code X-Search-Condition} で送信）。
     * </p>
     *
     * <p>
     * ★デバッグの要点：この3行が「加工前 → 加工後」です。
     * 生のヘッダー値（URIエンコード済み）、デコード後のJSON文字列、DTOの3段を出すので、
     * どこで壊れたのかを切り分けられます。
     * </p>
     * <ul>
     *   <li>生の値が出ない → Frontendが設定できていない（タイミング or ヘッダー名の誤り）</li>
     *   <li>生の値は出るがJSONが壊れている → エンコード／デコードの不一致</li>
     *   <li>DTOの項目がnull → Frontend側のDTO組み立て（applyFilter）で拾えていない</li>
     * </ul>
     */
    private Optional<SearchCondition> readSearchCondition(CdsReadEventContext context) {
        String encoded = context.getParameterInfo().getHeader(SEARCH_CONDITION_HEADER);
        if (encoded == null || encoded.isBlank()) {
            logger.debug("[F-DEBUG] ヘッダー {} は付いていません。", SEARCH_CONDITION_HEADER);
            return Optional.empty();
        }

        logger.debug("[F-DEBUG] 加工前: ヘッダーの生の値 = {}", encoded);

        try {
            // HTTP Headerへ日本語を安全に載せるため、FrontendはURIエンコードしています。
            String json = URLDecoder.decode(encoded, StandardCharsets.UTF_8);
            logger.debug("[F-DEBUG] 加工中: デコード後のJSON = {}", json);

            SearchCondition condition = JSON.readValue(json, SearchCondition.class);
            logger.debug("[F-DEBUG] 加工後: DTO = {}", condition);
            return Optional.of(condition);
        } catch (IllegalArgumentException | JsonProcessingException exception) {
            // 握りつぶさずに400へ落とします（条件不明のまま全件を返す事故を防ぐため）。
            throw new IllegalArgumentException("X-Search-Condition is not valid JSON.", exception);
        }
    }

    /**
     * Navigationの選択行制約を外し、本文テーブル用Entity Setを直接読むCQNへ変更します。
     * orderBy、limit、columnsなどは受信CQNの内容を維持します。
     */
    private String rewriteBulkItemsQuery(
            CdsReadEventContext context,
            Optional<SearchCondition> headerCondition) {
        try {
            ObjectNode root = (ObjectNode) JSON.readTree(context.getCqn().toString());
            ObjectNode select = (ObjectNode) root.required("SELECT");

            ObjectNode from = JSON.createObjectNode();
            from.set("ref", JSON.createArrayNode().add("WorkItemService.WorkItemBulkItems"));
            select.set("from", from);

            if (headerCondition.isPresent()) {
                // Header > OData Filter。Headerが届いた場合だけwhereを置き換えます。
                ArrayNode where = createWhere(headerCondition.get());
                if (where.isEmpty()) {
                    select.remove("where");
                } else {
                    select.set("where", where);
                }
            }
            // Headerがない場合はselect.whereを触らず、標準$filterをそのまま残します。

            return JSON.writeValueAsString(root);
        } catch (JsonProcessingException | ClassCastException exception) {
            throw new IllegalStateException("Failed to rewrite WorkItemBulkItems READ CQN.", exception);
        }
    }

    /** Header DTOからCAP CQNのwhere配列を生成します。 */
    private ArrayNode createWhere(SearchCondition condition) {
        ArrayNode where = JSON.createArrayNode();
        addCondition(where, "location", "=", condition.location());
        addCondition(where, "businessDate", ">=", condition.fromDate());
        addCondition(where, "businessDate", "<=", condition.toDate());
        addCondition(where, "status", "=", condition.status());
        return where;
    }

    private void addCondition(ArrayNode where, String field, String operator, String value) {
        if (value == null || value.isBlank()) {
            return;
        }
        if (!where.isEmpty()) {
            where.add("and");
        }

        ObjectNode reference = JSON.createObjectNode();
        reference.set("ref", JSON.createArrayNode().add(field));
        where.add(reference);
        where.add(operator);

        ObjectNode literal = JSON.createObjectNode();
        literal.put("val", value);
        where.add(literal);
    }

    private String display(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value;
    }

    /** sessionStorage、HTTP Header、CAPで共通利用する検索条件です。 */
    private record SearchCondition(
            String location,
            String fromDate,
            String toDate,
            String status) {

        String periodText() {
            if (fromDate != null && !fromDate.isBlank() && toDate != null && !toDate.isBlank()) {
                return fromDate.replace('-', '/') + "～" + toDate.replace('-', '/');
            }
            if (fromDate != null && !fromDate.isBlank()) {
                return fromDate.replace('-', '/') + "以降";
            }
            if (toDate != null && !toDate.isBlank()) {
                return toDate.replace('-', '/') + "以前";
            }
            return "未指定";
        }
    }
}
