import Filter from "sap/ui/model/Filter";
import FilterOperator from "sap/ui/model/FilterOperator";
import Event from "sap/ui/base/Event";
import { logStep } from "./debugLog";

/**
 * ============================================================================
 * 画面の検索条件を読み書きする処理をまとめたモジュール
 * ============================================================================
 *
 * 変換は全部ここに集めてあり、副作用（通信・画面操作）は持ちません。
 * コントローラ側は「いつ呼ぶか」だけを担当します。
 *
 * ----------------------------------------------------------------------------
 * 前提知識：画面の検索条件は何という形で存在しているのか
 * ----------------------------------------------------------------------------
 * ユーザーが FilterBar に入れた値は、サーバへ送られるまでに形を変えます。
 *
 *   ①画面の入力欄（MDC FilterField）
 *        ↓ FEが正規化（セマンティック日付の展開、型変換など）
 *   ②Condition（{ operator: "EQ", values: ["東京"] } のような素のオブジェクト）
 *        ↓ Binding へ渡すために変換
 *   ③sap/ui/model/Filter オブジェクト（このモジュールが主に読む形）
 *        ↓ ODataModel が URL へ変換
 *   ④OData の $filter 文字列（location eq '東京' and ...）
 *
 * beforeRebindTable で手に入るのは基本③ですが、UI5 / FE の版や呼ばれ方によって
 * ②（Condition Map）で来ることもあります。だからこのモジュールは
 * <b>③と②の両方を読めるように</b> 作ってあります（applyFilter / applyConditionMap）。
 *
 * ----------------------------------------------------------------------------
 * Filter オブジェクトの中身（③）
 * ----------------------------------------------------------------------------
 * 公式APIに getter が無いため、実装では内部プロパティを直接読んでいます。
 *
 *   sPath     … 項目名（例: "businessDate"）
 *   sOperator … 演算子（"EQ" / "BT" / "GE" / "LE" / "Contains" …）
 *   oValue1   … 1つ目の値（BT なら開始）
 *   oValue2   … 2つ目の値（BT の終了。他は undefined）
 *   aFilters  … 子Filter配列。AND/OR で束ねられている場合はここに入り、入れ子になる
 *
 * ★入れ子になるのが厄介な点です。条件が2つ以上あると
 *   「aFilters を持つFilter」の中に「実際の条件を持つFilter」が入るため、
 *   トップレベルだけ見ると sPath が undefined で「条件なし」に見えてしまいます。
 *   そのため applyFilter / collectFilters は必ず<b>再帰</b>で降りていきます。
 */

/** sessionStorage、HTTP Header、CAP DTOで共通利用する検索条件です。 */
export type SearchCondition = {
  location?: string;
  fromDate?: string;
  toDate?: string;
  status?: string;
};

export const STORAGE_KEY = "f.retry.edit.searchCondition";
export const HEADER_NAME = "X-Search-Condition";

type FilterInfo = {
  filters?: unknown;
  conditions?: Record<string, unknown[]>;
  filterConditions?: Record<string, unknown[]>;
};

/**
 * Filter に入っていた値を、DTO（JSON）に載せられる文字列へ整えます。
 *
 * ★日付は Date オブジェクトで来ることがあります。
 *   そのまま JSON.stringify すると "2026-08-01T00:00:00.000Z" のような形になり、
 *   CAP 側の Edm.Date（"2026-08-01"）と噛み合いません。
 *   ここで先頭10文字を切り出して "yyyy-MM-dd" に揃えています。
 *
 * ★空文字を undefined にしているのは、DTOのキー自体を消すためです。
 *   キーが残っていると CAP 側で「空文字と等しい」という条件になってしまいます。
 */
function toText(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return String(value);
}

/**
 * UI5 Filterのうち、このサンプルが扱う4項目だけをDTOへ変換します。
 *
 * ここが「画面の条件を読み取る本体」です。読んでいるのは前述の内部プロパティで、
 * 対応表は次のとおりです。
 *
 *   location     EQ           → condition.location
 *   status       EQ           → condition.status
 *   businessDate BT(a, b)     → fromDate = a, toDate = b
 *   businessDate GE(a)        → fromDate = a
 *   businessDate LE(a)        → toDate   = a
 *   businessDate EQ(a)        → fromDate = toDate = a （単一日を範囲として扱う）
 *
 * ★上記に無い組み合わせ（別項目・Contains・複数値のORなど）は<b>無視されます</b>。
 *   「条件を入れたのに Object Page に効いていない」ときの第一候補がこれです。
 *   詳細ログを有効にすると、無視した条件がそのまま出力されます（下の logStep）。
 */
function applyFilter(condition: SearchCondition, filter: Filter): void {
  const raw = filter as unknown as {
    aFilters?: Filter[];
    sPath?: string;
    sOperator?: string;
    oValue1?: unknown;
    oValue2?: unknown;
  };

  // 束ねFilter（AND/OR）なら、子へ降りていきます。ここを飛ばすと条件を取りこぼします。
  if (Array.isArray(raw.aFilters)) {
    raw.aFilters.forEach((child) => applyFilter(condition, child));
    return;
  }

  const value1 = toText(raw.oValue1);
  const value2 = toText(raw.oValue2);

  // 1条件ずつ、加工前の生の値を出します。
  // 「画面では 2026/08/01 なのにここでは Date が入っている」「演算子が期待と違う」
  // といったズレは、この出力を見ると即座に分かります。
  logStep("　└ applyFilter", `加工前: ${raw.sPath} ${raw.sOperator}`, {
    oValue1: raw.oValue1,
    oValue2: raw.oValue2,
    toText1: value1,
    toText2: value2
  });

  if (raw.sPath === "location" && raw.sOperator === "EQ") {
    condition.location = value1;
  } else if (raw.sPath === "status" && raw.sOperator === "EQ") {
    condition.status = value1;
  } else if (raw.sPath === "businessDate") {
    switch (raw.sOperator) {
      case "BT":
        condition.fromDate = value1;
        condition.toDate = value2;
        break;
      case "GE":
        condition.fromDate = value1;
        break;
      case "LE":
        condition.toDate = value1;
        break;
      case "EQ":
        condition.fromDate = value1;
        condition.toDate = value1;
        break;
      default:
        // businessDate に想定外の演算子（NE、Contains など）が来たケース。
        logStep("　└ applyFilter", `★無視した条件: businessDate ${raw.sOperator}`, raw.oValue1);
        break;
    }
  } else {
    // 対応表に無い項目・演算子。ここに出た条件は Object Page に効きません。
    // 「一覧では絞れているのに明細が全件出る」ときは、まずこの出力を確認してください。
    logStep("　└ applyFilter", `★無視した条件: ${raw.sPath} ${raw.sOperator}`, raw.oValue1);
  }
}

/**
 * FE/UI5のバージョン差でFilterではなくCondition Mapが返る場合の変換です。
 *
 * Condition Map は、Filter へ変換される前の素の形（前述の②）で、
 *
 *   { businessDate: [ { operator: "DATERANGE", values: ["2026-08-01", "2026-08-31"] } ] }
 *
 * のように「項目名 → 条件の配列」という構造をしています。
 * このモジュールは Filter 用の読み取り処理（applyFilter）を再利用したいので、
 * Condition を Filter と同じプロパティ名（sPath / sOperator / oValue1 / oValue2）を持つ
 * 疑似オブジェクトへ組み替えてから applyFilter に渡しています。
 *
 * ★DATERANGE を BT に読み替えているのは、FEのセマンティック日付演算子と
 *   UI5 Filter の演算子で名前が違うためです（意味は同じ「範囲」）。
 */
function applyConditionMap(
  condition: SearchCondition,
  map: Record<string, unknown[]> | undefined
): void {
  if (!map) {
    return;
  }

  Object.entries(map).forEach(([path, entries]) => entries.forEach((entry) => {
    const item = entry as { operator?: string; values?: unknown[] };
    const values = item.values ?? [];
    applyFilter(condition, {
      sPath: path,
      sOperator: item.operator === "DATERANGE" ? "BT" : item.operator,
      oValue1: values[0],
      oValue2: values[1]
    } as unknown as Filter);
  }));
}

/**
 * beforeRebindTableのイベント構造はFEの版によって配列・単一Filter・入れ子になります。
 * オブジェクトに直接forEachせず、再帰的にFilterだけを収集します。
 *
 * ----------------------------------------------------------------------------
 * この関数がやっていること
 * ----------------------------------------------------------------------------
 * 渡された任意のオブジェクトを深さ優先でたどり、
 * 「sPath と sOperator の両方を持つもの」＝実際の1条件だけを集めます。
 * 途中で辿る枝は次の4つで、これがそのまま「条件が入っている可能性のある場所」の一覧です。
 *
 *   aFilters              … Filter の子（AND/OR の中身）
 *   filters               … bindingParams.filters など、Binding設定の中の条件
 *   collectionBindingInfo … beforeRebindTable のパラメータ（新しい呼び名）
 *   bindingParams         … beforeRebindTable のパラメータ（従来の呼び名）
 *
 * ★seen（Set）で訪問済みを覚えているのは、循環参照で無限ループしないためです。
 *   Bindingオブジェクトは相互に参照を持つことがあります。
 *
 * ★「配列で来る前提」「単一Filterで来る前提」のどちらで書いても版差で壊れるため、
 *   形を判定せずに"探しに行く"という作りにしています。
 */
function collectFilters(...roots: unknown[]): Filter[] {
  const found: Filter[] = [];
  const seen = new Set<unknown>();

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const raw = value as {
      aFilters?: unknown;
      filters?: unknown;
      sPath?: string;
      sOperator?: string;
      collectionBindingInfo?: unknown;
      bindingParams?: unknown;
    };
    if (raw.sPath && raw.sOperator) {
      found.push(value as Filter);
      return;
    }

    visit(raw.aFilters);
    visit(raw.filters);
    visit(raw.collectionBindingInfo);
    visit(raw.bindingParams);
  };

  roots.forEach(visit);
  return found;
}

/**
 * List Reportで実際に利用された検索条件をイベントから読み取ります。
 *
 * ----------------------------------------------------------------------------
 * 3段構えになっている理由（優先順位つき）
 * ----------------------------------------------------------------------------
 *   1. event 由来（effectiveFilters）
 *      … そのREADに実際に使われる条件。最も信頼できるので第一候補。
 *   2. api.getFilters() 由来（fallbackFilters）
 *      … FilterBar の現在状態。1が空だったときの保険。
 *   3. Condition Map（filterInfo.conditions / filterConditions）
 *      … Filter 形式が一切取れなかったときの最後の手段。
 *
 * 上から順に試し、何か1つでも取れた時点でそれを採用します。
 * 「取れなかったら全件」ではなく「取れなかったら空DTO」を返すため、
 * 空DTO＝全件対象になります（呼び出し側で警告ログを出しています）。
 */
export function readSearchCondition(filterInfo: FilterInfo, event: Event): SearchCondition {
  const result: SearchCondition = {};
  const effectiveFilters = collectFilters(
    event.getParameter("collectionBindingInfo"),
    event.getParameter("bindingParams")
  );
  const fallbackFilters = collectFilters(filterInfo.filters);

  // どの経路で条件が取れたのかを記録します。
  // 「1が空で2が使われている」場合、イベントの形が想定と違っている可能性があります。
  logStep("　└ readSearchCondition", "採用した経路", {
    eventから取れた件数: effectiveFilters.length,
    getFiltersから取れた件数: fallbackFilters.length,
    採用: effectiveFilters.length ? "event（推奨）" : "getFilters（フォールバック）"
  });

  (effectiveFilters.length ? effectiveFilters : fallbackFilters)
    .forEach((filter) => applyFilter(result, filter));

  if (Object.keys(result).length === 0) {
    // Filter 形式で何も取れなかったので、Condition Map 形式を試します。
    logStep("　└ readSearchCondition", "Filterから取得できず Condition Map を試行", {
      conditions: filterInfo.conditions,
      filterConditions: filterInfo.filterConditions
    });
    applyConditionMap(result, filterInfo.conditions);
    applyConditionMap(result, filterInfo.filterConditions);
  }
  return result;
}

/**
 * sessionStorage に保存された条件を読み出します（Object Page 側の入口）。
 *
 * ★保存が無い場合は空オブジェクトを返します。
 *   つまり「List Report を経由せずに Object Page の URL を直接開いた」場合、
 *   条件なし＝全件が明細に出ます。URL だけでは画面を再現できないという
 *   この方式の性質が、ここに現れています。
 *
 * ★コンソールから直接確認するとき:
 *     JSON.parse(sessionStorage.getItem("f.retry.edit.searchCondition"))
 */
export function loadSearchCondition(): SearchCondition {
  const json = sessionStorage.getItem(STORAGE_KEY);
  logStep("　└ loadSearchCondition", "sessionStorage の生の文字列", json);
  return json ? JSON.parse(json) as SearchCondition : {};
}

/**
 * 保存済みDTOからObject Page本文用の標準OData Filterを再生成します。
 *
 * DTO → Filter は、List Report でやった Filter → DTO の逆変換です。
 * ここで作った Filter は最終的に OData の $filter 文字列になります。
 *
 *   { location: "東京", fromDate: "2026-08-01", toDate: "2026-08-31", status: "OPEN" }
 *     ↓
 *   location eq '東京' and businessDate ge 2026-08-01
 *     and businessDate le 2026-08-31 and status eq 'OPEN'
 *
 * ★日付範囲を BT ではなく GE + LE の2本に分けています。
 *   結果は同じですが、片側だけ指定された場合（fromDate のみ等）を
 *   分岐なしで表現できるためです。
 */
export function createODataFilters(condition: SearchCondition): Filter[] {
  const filters: Filter[] = [];
  if (condition.location) {
    filters.push(new Filter({ path: "location", operator: FilterOperator.EQ, value1: condition.location }));
  }
  if (condition.fromDate) {
    filters.push(new Filter({ path: "businessDate", operator: FilterOperator.GE, value1: condition.fromDate }));
  }
  if (condition.toDate) {
    filters.push(new Filter({ path: "businessDate", operator: FilterOperator.LE, value1: condition.toDate }));
  }
  if (condition.status) {
    filters.push(new Filter({ path: "status", operator: FilterOperator.EQ, value1: condition.status }));
  }
  return filters;
}

/**
 * beforeRebindTableが渡すBinding情報へ、保存条件を追加します。
 *
 * ----------------------------------------------------------------------------
 * 「画面へ値を返す」側の処理はここだけです
 * ----------------------------------------------------------------------------
 * beforeRebindTable のパラメータは<b>書き換え可能</b>で、ここに Filter を足すと
 * そのREADの $filter に反映されます。逆に言えば、このタイミングを外して
 * あとから Binding をいじっても、そのREADには間に合いません。
 *
 * bindingParams / collectionBindingInfo のどちらが渡されるかは版によるため、
 * 「オブジェクトとして存在する方」を採用しています。
 * どちらも無い場合は警告を出して何もしません（黙って条件なしで進めない）。
 */
export function appendFiltersToRebind(event: Event, additions: Filter[]): void {
  if (additions.length === 0) {
    return;
  }

  const candidates = [
    event.getParameter("collectionBindingInfo"),
    event.getParameter("bindingParams")
  ];
  const target = candidates.find((value) => value && typeof value === "object") as
    { filters?: unknown } | undefined;

  if (!target) {
    console.warn("[f-retry-edit] beforeRebindTable did not provide mutable binding information.");
    return;
  }

  // 既存Filterは削除しません。NavigationやFEが付けた条件とANDで結合させます。
  if (Array.isArray(target.filters)) {
    target.filters.push(...additions);
  } else if (target.filters) {
    target.filters = [target.filters, ...additions];
  } else {
    target.filters = additions;
  }
}
