package customer.e_header_edit;

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
 * X-Search-Conditionを唯一の業務検索条件として扱うREAD Handlerです。
 *
 * このサンプルでは、条件の読み取り・JSON解析・WHERE生成をこのクラスに集約しています。
 * FrontendからObject Pageテーブルへ同じ条件を$filterとして再注入しないため、
 * HeaderとOData Filterの二重管理は発生しません。
 */
@Component
@ServiceName("WorkItemService")
public class WorkItemsHandler implements EventHandler {

    private static final Logger logger = LoggerFactory.getLogger(WorkItemsHandler.class);
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SEARCH_CONDITION_HEADER = "x-search-condition";

    @Autowired
    private PersistenceService db;

    /**
     * Object Page本文テーブルのREADだけを独自処理します。
     *
     * Headerあり:
     *   HeaderからWHEREを生成して業務データ集合を取得します。
     * Headerなし:
     *   受信したCQNをそのまま実行し、通常のOData Filter処理へ戻します。
     */
    @On(event = CqnService.EVENT_READ, entity = "WorkItemService.WorkItemBulkItems")
    public Result onReadBulkItems(CdsReadEventContext context) {
        Optional<SearchCondition> condition = readSearchCondition(context);

        if (condition.isEmpty()) {
            logger.info("WorkItemBulkItems READ without X-Search-Condition; use the normal OData query.");
            return db.run(context.getCqn());
        }

        String rewrittenCqn = createHeaderDrivenCqn(context, condition.get());
        logger.info("WorkItemBulkItems READ with X-Search-Condition: {}", condition.get());
        logger.debug("Header-driven CQN: {}", rewrittenCqn);

        // FEのテーブルREADは$count=trueを要求するため、独自実行側でもinlineCountを返します。
        return db.run(Select.cqn(rewrittenCqn).inlineCount());
    }

    /**
     * Object PageのルートEntityは標準Navigationのキーで通常どおり取得します。
     * 取得後、同じHeaderから画面ヘッダー用virtual項目を生成します。
     */
    @After(event = CqnService.EVENT_READ, entity = "WorkItemService.WorkItems")
    public void afterReadWorkItems(CdsReadEventContext context, List<CdsData> rows) {
        readSearchCondition(context).ifPresent(condition -> rows.forEach(row -> {
            row.put("searchLocation", display(condition.location(), "未指定"));
            row.put("searchPeriod", condition.periodText());
            row.put("searchStatus", display(condition.status(), "未指定"));
        }));
    }

    @Before(event = CqnService.EVENT_UPDATE, entity = "WorkItemService.WorkItemBulkItems")
    public void beforeUpdateBulkItem(CdsData row) {
        // 一括保存時は、変更された行ごとにこのログが出ます。
        logger.info("WorkItemBulkItems UPDATE: {}", row);
    }

    /**
     * CAP JavaではEvent ContextのParameterInfoからHTTP Headerを取得できます。
     * 日本語を安全にHTTP Headerへ載せるためFrontend側でencodeURIComponentしているので、
     * JSON Parseの前にUTF-8としてデコードします。
     */
    private Optional<SearchCondition> readSearchCondition(CdsReadEventContext context) {
        String encoded = context.getParameterInfo().getHeader(SEARCH_CONDITION_HEADER);

        if (encoded == null || encoded.isBlank()) {
            return Optional.empty();
        }

        try {
            String json = URLDecoder.decode(encoded, StandardCharsets.UTF_8);
            return Optional.of(JSON.readValue(json, SearchCondition.class));
        } catch (IllegalArgumentException | JsonProcessingException exception) {
            throw new IllegalArgumentException("X-Search-Condition is not valid JSON.", exception);
        }
    }

    /**
     * Navigation由来のfromをWorkItemBulkItems Entity Setへ置き換えます。
     * これにより、選択した1行のIDではなく検索結果集合をObject Page本文へ返せます。
     *
     * Headerがある場合、業務WHEREはHeaderから作り直します。Object Page側では同じ条件を
     * $filterへ再注入しないため、Headerが常に唯一の正になります。
     * orderBy、limit、columnsなど、業務条件以外のCQN要素は元のまま維持します。
     */
    private String createHeaderDrivenCqn(CdsReadEventContext context, SearchCondition condition) {
        try {
            ObjectNode root = (ObjectNode) JSON.readTree(context.getCqn().toString());
            ObjectNode select = (ObjectNode) root.required("SELECT");

            ObjectNode from = JSON.createObjectNode();
            ArrayNode ref = JSON.createArrayNode();
            ref.add("WorkItemService.WorkItemBulkItems");
            from.set("ref", ref);
            select.set("from", from);

            ArrayNode where = createWhere(condition);
            if (where.isEmpty()) {
                select.remove("where");
            } else {
                select.set("where", where);
            }

            return JSON.writeValueAsString(root);
        } catch (JsonProcessingException | ClassCastException exception) {
            throw new IllegalStateException("Failed to create WorkItemBulkItems READ CQN.", exception);
        }
    }

    /** Header DTOをCAP CQNのwhere配列へ変換する唯一の場所です。 */
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

    /** FrontendのsessionStorageおよびHTTP Headerと1対1で対応する最小DTOです。 */
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
