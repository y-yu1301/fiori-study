import ControllerExtension from "sap/ui/core/mvc/ControllerExtension";
import Filter from "sap/ui/model/Filter";
import Event from "sap/ui/base/Event";

/** sessionStorage、HTTP Header、CAP DTOで共通に使う検索条件の形です。 */
type SearchCondition = {
  location?: string;
  fromDate?: string;
  toDate?: string;
  status?: string;
};

type ODataModel = {
  changeHttpHeaders(headers: Record<string, string | undefined>): void;
};

type ExtensionApi = {
  getFilters(): { filters?: unknown; conditions?: Record<string, unknown[]>; filterConditions?: Record<string, unknown[]> };
  getModel(): ODataModel;
};

type ControllerThis = {
  base: {
    getExtensionAPI(): ExtensionApi;
  };
};

const STORAGE_KEY = "e.header.edit.searchCondition";
const HEADER_NAME = "X-Search-Condition";

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
 * 実際のList Report READへ使われるUI5 Filterから、要件の4項目だけを取り出します。
 * Object PageへUI5 Filter自体は渡さず、単純なDTOへ変換して保存します。
 */
function applyFilter(condition: SearchCondition, filter: Filter): void {
  const raw = filter as unknown as {
    aFilters?: Filter[];
    sPath?: string;
    sOperator?: string;
    oValue1?: unknown;
    oValue2?: unknown;
  };

  if (raw.aFilters) {
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

/** FEのバージョンによってFilterがconditions形式の場合も、同じDTOへ変換します。 */
function applyConditionMap(condition: SearchCondition, map: Record<string, unknown[]> | undefined): void {
  if (!map) {
    return;
  }

  Object.entries(map).forEach(([path, entries]) => {
    entries.forEach((entry) => {
      const item = entry as { operator?: string; values?: unknown[] };
      const values = item.values ?? [];
      const operator = item.operator === "DATERANGE" ? "BT" : item.operator;

      applyFilter(condition, {
        sPath: path,
        sOperator: operator,
        oValue1: values[0],
        oValue2: values[1]
      } as unknown as Filter);
    });
  });
}

/** beforeRebindTableから実際のbinding filterを再帰的に探します。 */
function collectFilters(...roots: unknown[]): Filter[] {
  const found: Filter[] = [];
  const seen = new Set<unknown>();

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) {
      return;
    }
    seen.add(value);

    // UI5のバージョンやイベント発生箇所によって、filtersは
    // Filter[]、単一Filter、またはFilterを保持するbinding情報になります。
    // 配列だけにforEachを呼び、単一オブジェクトは下で構造を確認します。
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

    // aFilters/filtersが配列とは限らないため、再びvisitへ渡します。
    // 今回の不具合はraw.filtersがオブジェクトなのにforEachを呼んだことが原因でした。
    visit(raw.aFilters);
    visit(raw.filters);
    visit(raw.collectionBindingInfo);
    visit(raw.bindingParams);
  };

  roots.forEach(visit);
  return found;
}

/** beforeRebindTableから実際のbinding filterを再帰的に探します。 */
function filtersFromRebind(event: Event): Filter[] {
  return collectFilters(
    event.getParameter("collectionBindingInfo"),
    event.getParameter("bindingParams")
  );
}

function readCondition(api: ExtensionApi, event: Event): SearchCondition {
  const result: SearchCondition = {};
  const filterInfo = api.getFilters();
  const effectiveFilters = filtersFromRebind(event);
  const fallbackFilters = collectFilters(filterInfo.filters);

  (effectiveFilters.length ? effectiveFilters : fallbackFilters)
    .forEach((filter) => applyFilter(result, filter));

  // Filterオブジェクトが取れないUI5バージョン向けの表現差吸収です。
  if (Object.keys(result).length === 0) {
    applyConditionMap(result, filterInfo.conditions);
    applyConditionMap(result, filterInfo.filterConditions);
  }

  return result;
}

function setHeaderFromStorage(model: ODataModel): void {
  const json = sessionStorage.getItem(STORAGE_KEY);

  model.changeHttpHeaders({
    // HTTP HeaderはByteString制約があるため、日本語を含むJSONをURIエンコードします。
    [HEADER_NAME]: json ? encodeURIComponent(json) : undefined
  });
}

export default ControllerExtension.extend("e.header.edit.ui.ext.controller.ListReportExt", {
  /**
   * List Reportの検索READ直前に、実際に使われる条件を保存します。
   * このREADにはカスタムHeaderを付けず、通常のOData Filterだけで検索させます。
   */
  onBeforeRebindWorkItems: function (this: ControllerThis, event: Event): void {
    const api = this.base.getExtensionAPI();
    const condition = readCondition(api, event);

    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(condition));
    api.getModel().changeHttpHeaders({ [HEADER_NAME]: undefined });
    console.info("[e-header-edit] Stored List Report search condition.", condition);
  },

  /**
   * 標準Navigationを止めず、その直前にHeaderを設定します。
   * したがってObject PageのルートBinding開始前からHeaderが有効で、リトライは不要です。
   */
  override: {
    routing: {
      onBeforeNavigation: function (this: ControllerThis): boolean {
        setHeaderFromStorage(this.base.getExtensionAPI().getModel());
        return false;
      }
    }
  }
});
