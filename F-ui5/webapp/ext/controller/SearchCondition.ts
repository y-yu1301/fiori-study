import Filter from "sap/ui/model/Filter";
import FilterOperator from "sap/ui/model/FilterOperator";
import Event from "sap/ui/base/Event";

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

function toText(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return String(value);
}

/** UI5 Filterのうち、このサンプルが扱う4項目だけをDTOへ変換します。 */
function applyFilter(condition: SearchCondition, filter: Filter): void {
  const raw = filter as unknown as {
    aFilters?: Filter[];
    sPath?: string;
    sOperator?: string;
    oValue1?: unknown;
    oValue2?: unknown;
  };

  if (Array.isArray(raw.aFilters)) {
    raw.aFilters.forEach((child) => applyFilter(condition, child));
    return;
  }

  const value1 = toText(raw.oValue1);
  const value2 = toText(raw.oValue2);
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
    }
  }
}

/** FE/UI5のバージョン差でFilterではなくCondition Mapが返る場合の変換です。 */
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

/** List Reportで実際に利用された検索条件をイベントから読み取ります。 */
export function readSearchCondition(filterInfo: FilterInfo, event: Event): SearchCondition {
  const result: SearchCondition = {};
  const effectiveFilters = collectFilters(
    event.getParameter("collectionBindingInfo"),
    event.getParameter("bindingParams")
  );
  const fallbackFilters = collectFilters(filterInfo.filters);

  (effectiveFilters.length ? effectiveFilters : fallbackFilters)
    .forEach((filter) => applyFilter(result, filter));

  if (Object.keys(result).length === 0) {
    applyConditionMap(result, filterInfo.conditions);
    applyConditionMap(result, filterInfo.filterConditions);
  }
  return result;
}

export function loadSearchCondition(): SearchCondition {
  const json = sessionStorage.getItem(STORAGE_KEY);
  return json ? JSON.parse(json) as SearchCondition : {};
}

/** 保存済みDTOからObject Page本文用の標準OData Filterを再生成します。 */
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

/** beforeRebindTableが渡すBinding情報へ、保存条件を追加します。 */
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
