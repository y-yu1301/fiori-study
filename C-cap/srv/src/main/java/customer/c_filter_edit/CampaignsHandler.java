package customer.c_filter_edit;

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

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.List;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * List ReportとObject Page本文の両方に出す編集対象 Campaigns のREAD/UPDATEサンプル。
 *
 * 今回のポイント:
 *   - UI5側は、List Reportの検索条件をObject Page本文テーブルREADの$filterとして付け直す
 *   - CAP Java側のBefore READでは、context.getCqn()からwhere条件を確認・抽出できる
 *   - 実案件では、ここで抽出した条件を使って関連テーブル検索や業務条件追加を行う
 *
 * Campaigns本体のREADではCQNを確認するだけですが、CampaignBulkItemsのREADでは
 * Object Page本体IDに縛られたナビゲーションREADを、検索条件ベースのREADへ差し替えます。
 * After READではvirtual項目 filterNote に表示用の確認メッセージを入れます。
 */
@Component
@ServiceName("CampaignService")
public class CampaignsHandler implements EventHandler {

    private static final Logger logger = LoggerFactory.getLogger(CampaignsHandler.class);
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final List<String> EDITABLE_FIELDS = List.of(
            "name",
            "keyword",
            "targetDate",
            "status",
            "assignee",
            "plannedQuantity",
            "actualQuantity",
            "comment");

    private static final Pattern LOWER_BOUND = Pattern.compile(
            "targetDate.*?(?:>=|ge).*?(\\d{4}-\\d{2}-\\d{2})");
    private static final Pattern UPPER_BOUND = Pattern.compile(
            "targetDate.*?(?:<=|le).*?(\\d{4}-\\d{2}-\\d{2})");
    private static final Pattern EQUALS = Pattern.compile(
            "targetDate[^<>]*?[^!<>]=[^=].*?(\\d{4}-\\d{2}-\\d{2})");

    private final ThreadLocal<FilterSummary> currentFilterSummary = new ThreadLocal<>();

    @Autowired
    private PersistenceService db;

    @Before(event = CqnService.EVENT_READ, entity = "CampaignService.Campaigns")
    public void beforeReadCampaigns(CdsReadEventContext context) {
        beforeRead(context, "Campaigns");
    }

    @Before(event = CqnService.EVENT_READ, entity = "CampaignService.CampaignBulkItems")
    public void beforeReadCampaignBulkItems(CdsReadEventContext context) {
        beforeRead(context, "CampaignBulkItems");

        // Beforeでは「List Report条件が明細READのwhereに届いているか」を確認するだけにします。
        // 実データの取得は下のOn READで明示的に行います。
        // ここでcontext.setCqn(...)だけに頼ると、標準ハンドラへ戻った後の$countやNavigation条件の扱いが
        // 見えづらくなり、今回のような「画面は200だがbusyが残る」不具合を追いにくくなります。
    }

    @On(event = CqnService.EVENT_READ, entity = "CampaignService.CampaignBulkItems")
    public Result onReadCampaignBulkItems(CdsReadEventContext context) {
        // Object Pageの本文テーブルREADは /Campaigns(ID)/bulkEditItems として来るため、
        // 標準の関連解決に任せるとObject Page本体のIDに縛られます。
        // そのため、FEから届いたwhere/filter/count/limit/orderByは残し、fromだけを
        // CampaignBulkItemsのEntity Setへ差し替えたCQNをPersistenceServiceで実行します。
        // これが「filterから受け取った条件を使って再検索し、画面へ返す」本体です。
        String rewrittenCqn = rewriteBulkItemsCqn(context.getCqn().toString());
        logger.info("CampaignBulkItems ON READ custom CQN: {}", rewrittenCqn);
        return db.run(Select.cqn(rewrittenCqn).inlineCount());
    }

    private String rewriteBulkItemsCqn(String cqnText) {
        try {
            ObjectNode root = (ObjectNode) JSON.readTree(cqnText);
            ObjectNode select = (ObjectNode) root.required("SELECT");

            ObjectNode from = JSON.createObjectNode();
            ArrayNode ref = JSON.createArrayNode();
            ref.add("CampaignService.CampaignBulkItems");
            from.set("ref", ref);
            select.set("from", from);

            return JSON.writeValueAsString(root);
        } catch (JsonProcessingException | ClassCastException e) {
            throw new IllegalStateException("Failed to rewrite CampaignBulkItems READ CQN.", e);
        }
    }

    private FilterSummary beforeRead(CdsReadEventContext context, String entityLabel) {
        String cqnText = context.getCqn().toString();
        FilterSummary summary = extractTargetDateFilter(cqnText);

        currentFilterSummary.set(summary);

        logger.info("{} BEFORE READ CQN: {}", entityLabel, context.getCqn());
        logger.info("{} extracted filter summary: {}", entityLabel, summary.toDisplayText());

        // 実案件の加工ポイント:
        // - summary.fromDate()/toDate()を使って関連テーブルを検索する
        // - context.getCqn()のwhereへ権限条件や業務条件を追加する
        // - 取得対象の項目やlimit/orderByを業務都合で調整する
        return summary;
    }

    @After(event = CqnService.EVENT_READ, entity = "CampaignService.Campaigns")
    public void afterReadCampaigns(List<CdsData> rows) {
        afterRead(rows);
    }

    @After(event = CqnService.EVENT_READ, entity = "CampaignService.CampaignBulkItems")
    public void afterReadCampaignBulkItems(List<CdsData> rows) {
        afterRead(rows);
    }

    private void afterRead(List<CdsData> rows) {
        FilterSummary summary = currentFilterSummary.get();
        currentFilterSummary.remove();

        if (summary == null || summary.isEmpty()) {
            return;
        }

        for (CdsData row : rows) {
            row.put("filterNote", summary.toDisplayText());
        }
    }

    @Before(event = CqnService.EVENT_UPDATE, entity = "CampaignService.Campaigns")
    public void beforeUpdateCampaigns(CdsData row) {
        keepDraftRootFromOverwritingBulkItemChanges(row);
        beforeUpdate(row, "Campaigns");
    }

    @Before(event = CqnService.EVENT_UPDATE, entity = "CampaignService.CampaignBulkItems")
    public void beforeUpdateCampaignBulkItems(CdsData row) {
        beforeUpdate(row, "CampaignBulkItems");
    }

    private void beforeUpdate(CdsData row, String entityLabel) {
        logger.info("{} BEFORE UPDATE data: {}", entityLabel, row);

        // Object Page本文テーブルで複数行を編集して保存すると、変更行ごとにUPDATEが来ます。
        // ここではログだけですが、実案件では入力値チェックや更新前の補完処理を行えます。
    }

    private void keepDraftRootFromOverwritingBulkItemChanges(CdsData draftRootRow) {
        // Object Page右上のEdit/SaveはDraft有効なCampaigns本体に対して動きます。
        // 一方、本文テーブルのCampaignBulkItemsは同じDBテーブルを直接編集する投影です。
        // そのままだと、保存時にCampaigns本体の古いDraft値が、本文テーブルで直前に更新した同一IDの値を
        // 上書きする可能性があります。ここではDraft側の保存直前に、現在のActive値を再読込して
        // 本体行の編集対象項目へ戻すことで、本文テーブル側の更新を潰さないようにしています。
        if (!Boolean.FALSE.equals(draftRootRow.get("IsActiveEntity"))) {
            return;
        }

        String id = valueAsString(draftRootRow.get("ID"));
        if (id == null) {
            return;
        }

        db.run(Select.from(cds.gen.c.filter.edit.Campaigns_.class)
                .where(c -> c.ID().eq(id)))
                .listOf(cds.gen.c.filter.edit.Campaigns.class)
                .stream()
                .findFirst()
                .ifPresent(activeRow -> {
                    for (String field : EDITABLE_FIELDS) {
                        draftRootRow.put(field, activeRow.get(field));
                    }
                    logger.info("Campaigns draft root synced from active row before activation: {}", id);
                });
    }

    private String valueAsString(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    private FilterSummary extractTargetDateFilter(String cqnText) {
        Optional<String> equals = firstMatch(EQUALS, cqnText);

        if (equals.isPresent()) {
            return new FilterSummary(equals.get(), equals.get());
        }

        return new FilterSummary(
                firstMatch(LOWER_BOUND, cqnText).orElse(null),
                firstMatch(UPPER_BOUND, cqnText).orElse(null));
    }

    private Optional<String> firstMatch(Pattern pattern, String text) {
        Matcher matcher = pattern.matcher(text);
        return matcher.find() ? Optional.of(matcher.group(1)) : Optional.empty();
    }

    private record FilterSummary(String fromDate, String toDate) {
        boolean isEmpty() {
            return fromDate == null && toDate == null;
        }

        boolean hasRange() {
            return fromDate != null && toDate != null;
        }

        String toDisplayText() {
            if (fromDate != null && toDate != null && fromDate.equals(toDate)) {
                return "targetDate = " + fromDate;
            }
            if (fromDate != null && toDate != null) {
                return "targetDate " + fromDate + " .. " + toDate;
            }
            if (fromDate != null) {
                return "targetDate >= " + fromDate;
            }
            if (toDate != null) {
                return "targetDate <= " + toDate;
            }
            return "no targetDate filter";
        }
    }
}
