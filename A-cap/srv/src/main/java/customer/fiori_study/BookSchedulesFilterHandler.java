package customer.fiori_study;

import com.sap.cds.ql.cqn.CqnBetweenPredicate;
import com.sap.cds.ql.cqn.CqnComparisonPredicate;
import com.sap.cds.ql.cqn.CqnConnectivePredicate;
import com.sap.cds.ql.cqn.CqnPredicate;
import com.sap.cds.ql.cqn.CqnValue;
import com.sap.cds.services.cds.CdsReadEventContext;
import com.sap.cds.services.cds.CqnService;
import com.sap.cds.services.handler.EventHandler;
import com.sap.cds.services.handler.annotations.Before;
import com.sap.cds.services.handler.annotations.ServiceName;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Object Page の関連テーブル READ に、画面側で追加した $filter が届くことを確認するサンプル。
 *
 * 画面側の流れ:
 *   1. ListReportExt が List Report の検索条件を URL/sessionStorage に保存
 *   2. ObjectPageExt が schedules テーブルの beforeRebindTable で Filter を追加
 *   3. OData リクエストは /Books(...)/schedules?$filter=... になる
 *
 * ★このハンドラーの狙い（現場要件）:
 *   実際の業務アプリでは「標準 CQN をそのまま DB に流す」のではなく、
 *   届いた $filter から日付範囲(from/to)を"明示的に取り出して"、
 *   その値で独自のデータ取得ロジックを呼ぶ、という作りになっている。
 *   そのため、ここでは CQN の where 句を解析して businessDate の下限/上限を
 *   抽出できることを実証する。
 */
@Component
@ServiceName("CatalogService")
public class BookSchedulesFilterHandler implements EventHandler {

    private static final Logger logger = LoggerFactory.getLogger(BookSchedulesFilterHandler.class);

    /** 解析対象の項目名。ここでは明細側の businessDate だけを見る。 */
    private static final String TARGET_ELEMENT = "businessDate";

    @Before(event = CqnService.EVENT_READ, entity = "CatalogService.BookSchedules")
    public void beforeReadBookSchedules(CdsReadEventContext context) {
        // まずは生の CQN をログ（届いているかの確認用）。
        logger.info("BookSchedules READ CQN: {}", context.getCqn());

        // where 句が無ければ検索条件なし。
        DateRange range = new DateRange();
        context.getCqn().where().ifPresent(where -> walk(where, range));

        // ★ここが本命：filter から取り出した「明示的な日付範囲」。
        //   実際の業務ロジックでは、この from/to を使って独自 READ を行う。
        logger.info("抽出結果 businessDate: from={} (inclusive={}), to={} (inclusive={})",
                range.from, range.fromInclusive, range.to, range.toInclusive);
    }

    /**
     * where 句(述語ツリー)を再帰的に辿り、businessDate の比較条件を拾う。
     *
     * $filter は次のような木構造の CqnPredicate になる:
     *   - CqnConnectivePredicate … AND / OR / NOT（子述語を持つ）
     *   - CqnComparisonPredicate … businessDate >= 2026-08-01 のような比較
     *   - CqnBetweenPredicate    … businessDate BETWEEN a AND b（BT を使う場合）
     */
    private void walk(CqnPredicate predicate, DateRange range) {
        if (predicate instanceof CqnConnectivePredicate connective) {
            // AND/OR の入れ子。子をすべて辿る。
            connective.predicates().forEach(child -> walk(child, range));
            return;
        }

        if (predicate instanceof CqnBetweenPredicate between) {
            if (isTargetRef(between.value())) {
                range.setFrom(literal(between.low()), true);
                range.setTo(literal(between.high()), true);
            }
            return;
        }

        if (predicate instanceof CqnComparisonPredicate comparison) {
            // left が businessDate 参照、right がリテラル値、という前提で拾う。
            if (!isTargetRef(comparison.left())) {
                return;
            }
            String value = literal(comparison.right());
            switch (comparison.operator()) {
                case GE -> range.setFrom(value, true);   // 以上
                case GT -> range.setFrom(value, false);  // より後
                case LE -> range.setTo(value, true);     // 以下
                case LT -> range.setTo(value, false);    // より前
                // OData の `eq <日付リテラル>` は CQN 上 EQ ではなく IS に正規化される。
                // 右辺がリテラル（= null 判定ではない）なら「単日指定」として扱う。
                case EQ, IS -> {                          // 単日指定
                    if (comparison.right().isLiteral()) {
                        range.setFrom(value, true);
                        range.setTo(value, true);
                    }
                }
                default -> { /* NE/IS_NOT などはこのサンプルでは無視 */ }
            }
        }
    }

    /** CqnValue が businessDate への参照かどうか。 */
    private boolean isTargetRef(CqnValue value) {
        return value.isRef() && TARGET_ELEMENT.equals(value.asRef().lastSegment());
    }

    /** リテラル値を文字列として取り出す（date リテラルは LocalDate 等）。 */
    private String literal(CqnValue value) {
        return value.isLiteral() ? String.valueOf(value.asLiteral().value()) : value.toString();
    }

    /** 抽出した下限/上限を保持する小さな入れ物。 */
    private static final class DateRange {
        String from;
        String to;
        boolean fromInclusive;
        boolean toInclusive;

        void setFrom(String v, boolean inclusive) {
            this.from = v;
            this.fromInclusive = inclusive;
        }

        void setTo(String v, boolean inclusive) {
            this.to = v;
            this.toInclusive = inclusive;
        }
    }
}
