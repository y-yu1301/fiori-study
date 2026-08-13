package customer.d_bulk_edit.handlers;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

import org.springframework.stereotype.Component;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sap.cds.ql.CQL;
import com.sap.cds.ql.Predicate;
import com.sap.cds.services.ErrorStatuses;
import com.sap.cds.services.ServiceException;

/**
 * 画面から渡された「絞り込み条件の JSON」を、CAP のクエリ条件（CQN の述語）に翻訳するクラス。
 *
 * <h2>なぜこのクラスが独立しているのか</h2>
 * ここは<b>外部から来た文字列を解釈する場所</b>＝いちばん危険な場所です。
 * SQL 文字列を組み立てるのではなく CQN（クエリを表すオブジェクト）を組み立て、
 * さらに項目名と演算子をホワイトリストで検証します。
 * 検証と変換だけを行い、DB アクセスも画面依存も持たないので、単体で読めます。
 *
 * <h2>受け取る JSON の形（フロントの ext/filterSerializer.ts が生成します）</h2>
 *
 * <pre>
 * // 単一条件
 * { "kind": "cond", "path": "status", "operator": "EQ", "value1": "SUBMITTED" }
 *
 * // 2値演算子（BETWEEN）
 * { "kind": "cond", "path": "requestDate", "operator": "BT",
 *   "value1": "2026-01-01", "value2": "2026-06-30" }
 *
 * // 論理結合（and: true なら AND、false なら OR）
 * { "kind": "group", "and": true, "filters": [ ...上記 or group の配列... ] }
 * </pre>
 *
 * <h2>方針：迷ったら通さない</h2>
 * ホワイトリスト外の項目、未対応の演算子、深すぎるネスト、多すぎる条件は
 * すべて 400 エラーで<b>即座に拒否</b>します。
 * 「解釈できなかったので無視して全件」のようなフォールバックは、
 * 意図しない大量更新につながるため一切行いません。
 */
@Component
public class CriteriaTranslator {

    /** 条件に使ってよい項目と、その型。ここに無い項目名が来たらエラーにします。 */
    public static final Map<String, FieldType> ALLOWED_PATHS = Map.of(
            "requestNo",   FieldType.STRING,
            "title",       FieldType.STRING,
            "department",  FieldType.STRING,
            "status",      FieldType.STRING,
            "remark",      FieldType.STRING,
            "requestDate", FieldType.DATE,
            "quantity",    FieldType.INTEGER,
            "unitPrice",   FieldType.DECIMAL);

    /** ネストの深さの上限（悪意ある巨大 JSON でサーバを詰まらせないため）。 */
    public static final int MAX_DEPTH = 5;

    /** 条件（cond）の個数の上限。 */
    public static final int MAX_CONDITIONS = 200;

    /** 項目の型。文字列関数（Contains など）は STRING 項目にしか使えません。 */
    public enum FieldType {
        STRING, DATE, INTEGER, DECIMAL
    }

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * 条件 JSON を CQN の述語へ翻訳します。
     *
     * @param criteriaJson フロントから受け取った JSON 文字列（null／空／"{}" は「条件なし」）
     * @return 条件が1つも無ければ empty。あれば where に渡せる述語。
     */
    public Optional<Predicate> translate(String criteriaJson) {
        if (criteriaJson == null || criteriaJson.isBlank()) {
            return Optional.empty();
        }

        JsonNode root;
        try {
            root = JSON.readTree(criteriaJson);
        } catch (Exception e) {
            throw badRequest("絞り込み条件のJSONを解析できませんでした: " + e.getMessage());
        }

        if (root == null || root.isNull() || root.isEmpty()) {
            return Optional.empty();
        }

        // 条件数のカウンタ。再帰の中で共有したいので1要素配列で持ちます。
        int[] conditionCount = new int[] { 0 };
        Predicate predicate = toPredicate(root, 1, conditionCount);
        return Optional.ofNullable(predicate);
    }

    // -------------------------------------------------------------------------
    // 再帰の本体：ノード1つを述語1つに変換する
    // -------------------------------------------------------------------------
    private Predicate toPredicate(JsonNode node, int depth, int[] conditionCount) {
        if (depth > MAX_DEPTH) {
            throw badRequest("絞り込み条件のネストが深すぎます（上限 " + MAX_DEPTH + " 階層）");
        }
        if (!node.isObject()) {
            throw badRequest("絞り込み条件の形式が不正です（オブジェクトではありません）");
        }

        String kind = text(node, "kind");
        if ("group".equals(kind)) {
            return toGroupPredicate(node, depth, conditionCount);
        }
        if ("cond".equals(kind)) {
            conditionCount[0]++;
            if (conditionCount[0] > MAX_CONDITIONS) {
                throw badRequest("絞り込み条件が多すぎます（上限 " + MAX_CONDITIONS + " 件）");
            }
            return toConditionPredicate(node);
        }
        throw badRequest("未対応の kind です: " + kind);
    }

    /** group ノード（and / or の結合）を、子の述語を畳み込んで1つにします。 */
    private Predicate toGroupPredicate(JsonNode node, int depth, int[] conditionCount) {
        JsonNode filters = node.get("filters");
        if (filters == null || !filters.isArray()) {
            throw badRequest("group には配列 filters が必要です");
        }

        boolean and = !node.has("and") || node.get("and").asBoolean(true);
        Predicate combined = null;
        for (JsonNode child : filters) {
            Predicate p = toPredicate(child, depth + 1, conditionCount);
            if (p == null) {
                continue;
            }
            // 先頭はそのまま、2つ目以降は and / or でつないでいきます。
            combined = (combined == null) ? p : (and ? combined.and(p) : combined.or(p));
        }
        return combined; // 子が空なら null（＝条件なし）
    }

    /** cond ノード（1つの比較）を述語にします。ここでホワイトリスト検証を行います。 */
    private Predicate toConditionPredicate(JsonNode node) {
        String path = text(node, "path");
        String operator = text(node, "operator");

        FieldType type = ALLOWED_PATHS.get(path);
        if (type == null) {
            // ★ここが安全弁。画面が何を送ってきても、許可した項目以外では検索させません。
            throw badRequest("この項目では絞り込みできません: " + path
                    + "（許可されている項目: " + new java.util.TreeSet<>(ALLOWED_PATHS.keySet()) + "）");
        }

        Object v1 = convert(node.get("value1"), type, path);
        if (v1 == null) {
            throw badRequest("value1 が指定されていません: path=" + path);
        }

        // CQL.get(path) は「この項目を指す参照」。そこに演算子を付けて述語にします。
        var ref = CQL.get(path);

        switch (operator == null ? "" : operator) {
            case "EQ":
                return ref.eq(v1);
            case "NE":
                return ref.ne(v1);
            case "GT":
                return ref.gt(v1);
            case "GE":
                return ref.ge(v1);
            case "LT":
                return ref.lt(v1);
            case "LE":
                return ref.le(v1);
            case "BT": {
                // BETWEEN は「専用の演算子」を使わず ge かつ le に分解します。
                // どの DB でも同じ意味になり、生成される SQL も読みやすいためです。
                Object v2 = convert(node.get("value2"), type, path);
                if (v2 == null) {
                    throw badRequest("BT（BETWEEN）には value2 が必要です: path=" + path);
                }
                return ref.ge(v1).and(ref.le(v2));
            }
            case "Contains":
                return CQL.get(path).contains(CQL.val(requireString(v1, path, operator)));
            case "StartsWith":
                return CQL.get(path).startsWith(CQL.val(requireString(v1, path, operator)));
            case "EndsWith":
                return CQL.get(path).endsWith(CQL.val(requireString(v1, path, operator)));
            default:
                throw badRequest("未対応の演算子です: " + operator);
        }
    }

    // -------------------------------------------------------------------------
    // 値の変換（文字列で届いた値を、項目の型に合わせた Java の値へ）
    // -------------------------------------------------------------------------
    private Object convert(JsonNode value, FieldType type, String path) {
        if (value == null || value.isNull()) {
            return null;
        }
        String raw = value.isTextual() ? value.textValue() : value.toString();
        try {
            return switch (type) {
                case STRING  -> raw;
                case DATE    -> LocalDate.parse(raw);      // "2026-01-01"
                case INTEGER -> Integer.valueOf(raw.trim());
                case DECIMAL -> new BigDecimal(raw.trim());
            };
        } catch (RuntimeException e) {
            throw badRequest("値の形式が項目の型と合いません: path=" + path
                    + ", value=" + raw + ", expected=" + type);
        }
    }

    private String requireString(Object value, String path, String operator) {
        if (!(value instanceof String s)) {
            throw badRequest(operator + " は文字列項目にしか使えません: path=" + path);
        }
        return s;
    }

    private static String text(JsonNode node, String field) {
        JsonNode n = node.get(field);
        return (n == null || n.isNull()) ? null : n.asText();
    }

    private static ServiceException badRequest(String message) {
        // 400 を返す。ここで例外にせず「無視して続行」すると、
        // ユーザーの意図と違う範囲を一括更新してしまうため、必ず失敗させます。
        return new ServiceException(ErrorStatuses.BAD_REQUEST, message);
    }

    /** デバッグ用：許可項目の一覧（README や画面の説明に使えます）。 */
    public static Map<String, FieldType> allowedPaths() {
        return new LinkedHashMap<>(ALLOWED_PATHS);
    }
}
