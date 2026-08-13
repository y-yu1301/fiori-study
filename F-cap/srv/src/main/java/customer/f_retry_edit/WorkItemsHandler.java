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
     * Object Page本文テーブルのNavigationを、検索結果一覧用Entity Setへ差し替えます。
     *
     * <p>HeaderがあるときはHeaderを優先し、受信した$filterの業務条件を置き換えます。
     * Headerがないときはwhereを変更しないため、beforeRebindTableで追加した$filterが
     * フォールバックとして働きます。</p>
     */
    @On(event = CqnService.EVENT_READ, entity = "WorkItemService.WorkItemBulkItems")
    public Result onReadBulkItems(CdsReadEventContext context) {
        Optional<SearchCondition> headerCondition = readSearchCondition(context);
        String rewrittenCqn = rewriteBulkItemsQuery(context, headerCondition);

        if (headerCondition.isPresent()) {
            logger.info("WorkItemBulkItems READ source=HEADER condition={}", headerCondition.get());
        } else {
            logger.info("WorkItemBulkItems READ source=ODATA_FILTER");
        }
        logger.debug("Rewritten bulk-items CQN: {}", rewrittenCqn);

        // FEの一覧は$count=trueを使用するため、独自実行でもinlineCountを返します。
        return db.run(Select.cqn(rewrittenCqn).inlineCount());
    }

    /**
     * Object Pageルートは、選択された1行を標準Navigationのキーで取得します。
     * Headerが付かずに最初のREADが走った場合、virtual項目は空のままです。
     * FrontendがHeader設定に成功した後でルートContextをrefreshし、このAfter READを
     * もう一度実行させるのがFの再表示処理です。
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
                    EDITABLE_FIELDS.forEach(field -> draftRootRow.put(field, activeRow.get(field)));
                    logger.info("WorkItems draft root synced from active bulk-edit row before activation: {}", id);
                });
    }

    private String valueAsString(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    /** HTTP Headerをデコードし、Frontendと共通の小さなDTOへ変換します。 */
    private Optional<SearchCondition> readSearchCondition(CdsReadEventContext context) {
        String encoded = context.getParameterInfo().getHeader(SEARCH_CONDITION_HEADER);
        if (encoded == null || encoded.isBlank()) {
            return Optional.empty();
        }

        try {
            // HTTP Headerへ日本語を安全に載せるため、FrontendはURIエンコードしています。
            String json = URLDecoder.decode(encoded, StandardCharsets.UTF_8);
            return Optional.of(JSON.readValue(json, SearchCondition.class));
        } catch (IllegalArgumentException | JsonProcessingException exception) {
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
