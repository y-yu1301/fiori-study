import ControllerExtension from "sap/ui/core/mvc/ControllerExtension";
import Filter from "sap/ui/model/Filter";
import Event from "sap/ui/base/Event";

type PlainFilter = {
  sourcePath?: string;
  path: string;
  operator: string;
  value1?: string | number | boolean;
  value2?: string | number | boolean;
};

type SearchContext = {
  filters: PlainFilter[];
  search: string;
  summary: string;
  updatedAt: string;
};

type ControllerExtensionThis = {
  base: {
    getExtensionAPI(): {
      getFilters(): Record<string, unknown> & {
        filters?: Filter[];
        conditions?: Record<string, unknown[]>;
        filterConditions?: Record<string, unknown[]>;
      };
    };
  };
};

type RebindEvent = Event;

/**
 * List ReportとObject Page本文テーブルは同じ Campaigns Entity を読むため、
 * 項目名は変換せず同じ名前で渡します。
 */
const SOURCE_TO_TARGET_PATH: Record<string, string> = {
  targetDate: "targetDate",
  status: "status",
  keyword: "keyword",
  assignee: "assignee"
};

const SOURCE_LABELS: Record<string, string> = {
  targetDate: "対象日",
  status: "ステータス",
  keyword: "キーワード",
  assignee: "担当者",
  $search: "検索ワード"
};

function getFilterValue(value: unknown): string | number | boolean | undefined {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  return value === undefined || value === null ? undefined : String(value);
}

function normalizeOperator(operator: string): string {
  switch (operator) {
    case "DATE":
    case "DATERANGE":
      return "EQ";
    case "FROM":
      return "GE";
    case "TO":
      return "LE";
    default:
      return operator;
  }
}

function getSearchExpression(filterInfo: Record<string, unknown> | undefined): string {
  if (!filterInfo) {
    return "";
  }

  return String(filterInfo.searchExpression ?? filterInfo.search ?? filterInfo.$search ?? "");
}

function formatCondition(filter: PlainFilter): string {
  const label = SOURCE_LABELS[filter.sourcePath || ""] ?? filter.sourcePath ?? filter.path;

  switch (filter.operator) {
    case "BT":
      return `${label}: ${filter.value1} - ${filter.value2}`;
    case "GE":
      return `${label}: ${filter.value1} 以後`;
    case "GT":
      return `${label}: ${filter.value1} より後`;
    case "LE":
      return `${label}: ${filter.value1} 以前`;
    case "LT":
      return `${label}: ${filter.value1} より前`;
    case "EQ":
      return `${label}: ${filter.value1}`;
    default:
      return `${label}: ${filter.operator} ${filter.value1}${filter.value2 ? ` ${filter.value2}` : ""}`;
  }
}

const SEARCH_CONTEXT_STORAGE_KEY = "c.filter.edit.currentSearchContext";

function createSearchContext(filters: PlainFilter[], searchExpression: string): SearchContext {
  const summaryParts = filters.map(formatCondition);

  if (searchExpression) {
    summaryParts.push(`${SOURCE_LABELS.$search}: ${searchExpression}`);
  }

  return {
    filters,
    search: searchExpression,
    summary: summaryParts.join(" / "),
    updatedAt: new Date().toISOString()
  };
}

/**
 * Fiori Elementsが持つFilterをURLに載せられるplain objectへ変換します。
 * aFiltersでネストされる場合があるため、再帰的に辿ります。
 */
function serializeFilters(filters: Filter[]): PlainFilter[] {
  const result: PlainFilter[] = [];

  const visit = (filter: Filter): void => {
    const raw = filter as unknown as {
      aFilters?: Filter[];
      sPath?: string;
      sOperator?: string;
      oValue1?: unknown;
      oValue2?: unknown;
    };

    if (raw.aFilters) {
      raw.aFilters.forEach(visit);
      return;
    }

    if (!raw.sPath || !raw.sOperator || !SOURCE_TO_TARGET_PATH[raw.sPath]) {
      return;
    }

    result.push({
      sourcePath: raw.sPath,
      path: SOURCE_TO_TARGET_PATH[raw.sPath],
      operator: raw.sOperator,
      value1: getFilterValue(raw.oValue1),
      value2: getFilterValue(raw.oValue2)
    });
  };

  filters.forEach(visit);
  return result;
}

/**
 * beforeRebindTableのイベントには、実際にOData READへ使われるbinding情報が入ります。
 * FE/UI5のバージョン差で入れ子の形が変わることがあるため、Filterらしい値を構造的に辿ります。
 * ここで取れた条件を最優先にすることで、FilterBar状態の読み取りタイミングずれで
 * 前回検索条件がsessionStorageへ残る問題を避けます。
 */
function serializeFiltersFromRebindEvent(event: RebindEvent): PlainFilter[] {
  const result: PlainFilter[] = [];
  const seen = new Set<unknown>();
  const roots = [
    event.getParameter("collectionBindingInfo"),
    event.getParameter("bindingParams")
  ];

  const visit = (value: unknown): void => {
    if (!value || seen.has(value)) {
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    seen.add(value);

    const raw = value as {
      aFilters?: unknown[];
      filters?: unknown[];
      getFilters?: () => unknown[];
      sPath?: string;
      sOperator?: string;
      oValue1?: unknown;
      oValue2?: unknown;
      path?: string;
      operator?: string;
      value1?: unknown;
      value2?: unknown;
      collectionBindingInfo?: unknown;
      bindingParams?: unknown;
      parameters?: unknown;
      mParameters?: unknown;
    };
    const sourcePath = raw.sPath ?? raw.path;
    const operator = raw.sOperator ?? raw.operator;

    if (sourcePath && operator && SOURCE_TO_TARGET_PATH[sourcePath]) {
      result.push({
        sourcePath,
        path: SOURCE_TO_TARGET_PATH[sourcePath],
        operator,
        value1: getFilterValue(raw.oValue1 ?? raw.value1),
        value2: getFilterValue(raw.oValue2 ?? raw.value2)
      });
      return;
    }

    if (typeof raw.getFilters === "function") {
      raw.getFilters().forEach(visit);
    }

    raw.aFilters?.forEach(visit);
    raw.filters?.forEach(visit);

    [
      raw.collectionBindingInfo,
      raw.bindingParams,
      raw.parameters,
      raw.mParameters
    ].forEach((childValue) => {
      if (Array.isArray(childValue)) {
        childValue.forEach(visit);
      } else if (childValue && typeof childValue === "object") {
        visit(childValue);
      }
    });
  };

  roots.forEach(visit);
  return result;
}

/**
 * Fiori Elements V4 / MDC FilterBarでは、extensionAPI.getFilters()の戻り値の中で
 * 検索条件がsap.ui.model.Filterではなくconditions形式で保持される場合があります。
 *
 * 例:
 * {
 *   targetDate: [
 *     { operator: "BT", values: [Date, Date] }
 *   ]
 * }
 *
 * これは同じ取得元(extensionAPI.getFilters)の表現差を吸収するための処理です。
 * ここを読まないと、List Reportでは絞り込めているのにObject Pageへ渡す条件が空になります。
 */
function serializeFilterConditions(filterInfo: Record<string, unknown> | undefined): PlainFilter[] {
  const result: PlainFilter[] = [];
  const conditionMaps = [
    filterInfo?.conditions,
    filterInfo?.filterConditions
  ] as Array<Record<string, unknown[]> | undefined>;

  conditionMaps.forEach((conditionMap) => {
    if (!conditionMap) {
      return;
    }

    Object.entries(conditionMap).forEach(([sourcePath, conditions]) => {
      const targetPath = SOURCE_TO_TARGET_PATH[sourcePath];

      if (!targetPath || !Array.isArray(conditions)) {
        return;
      }

      conditions.forEach((condition) => {
        const rawCondition = condition as {
          operator?: string;
          values?: unknown[];
          value1?: unknown;
          value2?: unknown;
        };
        const operator = normalizeOperator(String(rawCondition.operator ?? "EQ"));
        const values = rawCondition.values ?? [];
        const value1 = getFilterValue(values[0] ?? rawCondition.value1);
        const value2 = getFilterValue(values[1] ?? rawCondition.value2);

        if (value1 === undefined) {
          return;
        }

        result.push({
          sourcePath,
          path: targetPath,
          operator,
          value1,
          value2
        });
      });
    });
  });

  return result;
}

function readCurrentListReportContext(
  extensionApi: ControllerExtensionThis["base"]["getExtensionAPI"] extends () => infer Api ? Api : never,
  event?: RebindEvent
): SearchContext {
  const filterInfo = extensionApi.getFilters();
  let filters = event ? serializeFiltersFromRebindEvent(event) : [];
  const searchExpression = getSearchExpression(filterInfo as Record<string, unknown> | undefined);

  if (!filters.length) {
    filters = serializeFilters((filterInfo.filters ?? []) as Filter[]);
  }

  if (!filters.length) {
    filters = serializeFilterConditions(filterInfo as Record<string, unknown> | undefined);
  }

  return createSearchContext(filters, searchExpression);
}

function storeCurrentListReportContext(
  extensionApi: ControllerExtensionThis["base"]["getExtensionAPI"] extends () => infer Api ? Api : never,
  reason: string,
  event?: RebindEvent
): SearchContext {
  const searchContext = readCurrentListReportContext(extensionApi, event);

  // List Reportの最新検索条件を、常に同じキーへ上書きします。
  // Object Page側はこのキーだけを読むため、ここが最新化されていれば前回条件は残りません。
  sessionStorage.setItem(SEARCH_CONTEXT_STORAGE_KEY, JSON.stringify(searchContext));
  console.info(`[c-filter-edit] Store List Report context on ${reason}.`, searchContext);

  return searchContext;
}

export default ControllerExtension.extend("c.filter.edit.ui.ext.controller.ListReportExt", {
  /**
   * List ReportのテーブルREAD直前に、検索条件をsessionStorageへ保存します。
   *
   * ここを主経路にします。検索ボタン押下やFilterBar変更後の再検索では、
   * Object Pageへ遷移する前に必ずList ReportテーブルのREADが走るためです。
   * Object Page遷移直前のonBeforeNavigationでは保存しません。
   * そこでは実際のOData READに使われたbinding filterではなく、更新前のFilterBar状態を
   * 読んでしまうことがあり、直前の正しい検索条件を古い条件で上書きするためです。
   */
  onBeforeRebindCampaigns: function (this: ControllerExtensionThis, event: RebindEvent): void {
    storeCurrentListReportContext(this.base.getExtensionAPI(), "list rebind", event);
  }
});
