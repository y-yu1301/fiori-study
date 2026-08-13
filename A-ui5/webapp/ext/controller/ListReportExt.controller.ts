import ControllerExtension from "sap/ui/core/mvc/ControllerExtension";
import Filter from "sap/ui/model/Filter";
import Context from "sap/ui/model/odata/v4/Context";

/**
 * Object Page へ持ち込むために、UI5 の Filter オブジェクトを plain object に落とした形。
 *
 * UI5 の Filter インスタンスはそのまま JSON.stringify して URL に載せる用途には向きません。
 * そのため、READ に再利用するために必要な path/operator/value だけを抜き出します。
 *
 * sourcePath:
 *   List Report 側の項目名。ヘッダー表示用のラベル判定に使います。
 * path:
 *   Object Page 明細側へ渡す項目名。ここでは Books.availableDate を
 *   BookSchedules.businessDate に変換します。
 */
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
};

type NavigationParameters = {
  bindingContext: Context;
};

/**
 * Fiori Elements の controller extension では、実行時に `this.base` が提供されます。
 * UI5 の型定義をこの学習プロジェクトには入れていないため、このサンプルで使う範囲だけ
 * 最小限の型として定義しています。
 */
type ControllerExtensionThis = {
  base: {
    getExtensionAPI(): {
      getFilters?(): Record<string, unknown> & {
        filters?: Filter[];
      };
    };
    getView(): object;
    getAppComponent(): {
      getRouter(): {
        navTo(routeName: string, parameters: object): void;
      };
    };
  };
};

const SOURCE_TO_TARGET_PATH: Record<string, string> = {
  availableDate: "businessDate"
};

/**
 * 画面表示用のラベル。
 * `$filter` に渡す値とは別に、人が読める表示文言を作るために使います。
 */
const SOURCE_LABELS: Record<string, string> = {
  availableDate: "対象日",
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

/**
 * List Report の基本検索欄に入力された検索ワードを取り出します。
 *
 * 日付などの項目条件は `$filter` になりますが、基本検索欄は `$search` として扱われます。
 * `$filter` だけを見ても検索ワードは拾えないため、filterInfo から別途取得します。
 */
function getSearchExpression(filterInfo: Record<string, unknown> | undefined): string {
  if (!filterInfo) {
    return "";
  }

  return String(filterInfo.searchExpression || filterInfo.search || filterInfo.$search || "");
}

/**
 * Object Page ヘッダーに表示する検索条件テキストを作ります。
 * 例:
 *   対象日: 2026-08-04 - 2026-08-12
 *   対象日: 2026-08-04 以後
 */
function formatCondition(filter: PlainFilter): string {
  const label = SOURCE_LABELS[filter.sourcePath || ""] || filter.sourcePath || filter.path;

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

/**
 * URL/sessionStorage に保存する検索コンテキストを作ります。
 *
 * filters:
 *   Object Page 明細の READ に `$filter` として再利用する機械処理用。
 * search/summary:
 *   Object Page ヘッダーに「検索条件」として表示する人間向け。
 */
function createSearchContext(filters: PlainFilter[], searchExpression: string): SearchContext {
  const summaryParts = filters.map(formatCondition);

  if (searchExpression) {
    summaryParts.push(`${SOURCE_LABELS.$search}: ${searchExpression}`);
  }

  return {
    filters,
    search: searchExpression,
    summary: summaryParts.join(" / ")
  };
}

/**
 * List Report の Filter オブジェクトを、Object Page 明細で使える PlainFilter に変換します。
 *
 * Fiori Elements が作る Filter はネストされることがあるため、aFilters を再帰的に辿ります。
 * このサンプルでは、List Report 側の availableDate 条件だけを対象にしています。
 * 追加したい項目がある場合は SOURCE_TO_TARGET_PATH にマッピングを追加します。
 */
function serializeDateFilters(filters: Filter[]): PlainFilter[] {
  const result: PlainFilter[] = [];

  const visit = (filter: Filter): void => {
    const raw = filter as unknown as {
      aFilters?: Filter[];
      sPath?: string;
      sOperator?: string;
      oValue1?: string | number | boolean;
      oValue2?: string | number | boolean;
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
 * extensionAPI.getFilters() で条件が取れない UI5 バージョン/タイミング向けのフォールバック。
 *
 * 実際に検索済みの List Report テーブル binding には aFilters が残っているため、
 * 画面内の Table を探して binding から Filter を拾います。
 */
function collectFiltersFromTableBindings(view: object): Filter[] {
  const controls = (view as {
    findAggregatedObjects(
      recursive: boolean,
      predicate: (control: {
        isA?(typeName: string): boolean;
        getBinding?(aggregationName: string): { aFilters?: Filter[] } | undefined;
      }) => boolean
    ): Array<{
      getBinding?(aggregationName: string): { aFilters?: Filter[] } | undefined;
    }>;
  }).findAggregatedObjects(true, (control) => {
    return Boolean(control.isA && (
      control.isA("sap.m.Table") ||
      control.isA("sap.ui.table.Table") ||
      control.isA("sap.ui.mdc.Table")
    ));
  });

  return controls.flatMap((control) => {
    return ["items", "rows"].flatMap((aggregationName) => {
      return control.getBinding?.(aggregationName)?.aFilters || [];
    });
  });
}

export default ControllerExtension.extend("project1.ext.controller.ListReportExt", {
  override: {
    routing: {
      /**
       * List Report の行から Object Page へ遷移する直前に呼ばれます。
       *
       * ここで標準遷移を一度止め、検索条件を URL query に含めた形で
       * BooksObjectPage へ navTo します。
       *
       * return true:
       *   Fiori Elements の標準ナビゲーションを止める。
       * return false:
       *   検索条件が無い場合は標準ナビゲーションに任せる。
       */
      onBeforeNavigation: function (this: ControllerExtensionThis, navigationParameters: NavigationParameters): boolean {
        const extensionApi = this.base.getExtensionAPI();
        const filterInfo = extensionApi.getFilters?.();
        let filters = serializeDateFilters((filterInfo?.filters || []) as Filter[]);
        const searchExpression = getSearchExpression(filterInfo as Record<string, unknown> | undefined);

        // UI5 のバージョンやタイミングによって extensionAPI.getFilters() が空の場合がある。
        // その場合は、実際の一覧テーブル binding から検索済み Filter を拾う。
        if (!filters.length) {
          filters = serializeDateFilters(collectFiltersFromTableBindings(this.base.getView()));
        }

        if (!filters.length && !searchExpression) {
          return false;
        }

        const searchContext = createSearchContext(filters, searchExpression);
        const encodedContext = encodeURIComponent(JSON.stringify(searchContext));
        const encodedFilters = encodeURIComponent(JSON.stringify(filters));
        const path = navigationParameters.bindingContext.getPath();
        const key = path.replace(/^\/Books\(/, "").replace(/\)$/, "");

        // route pattern が `Books({key}):?query:` なので、query は `"?query"` キーで渡す。
        // URL 例:
        //   #/Books(550e...)?lrContext=...
        this.base.getAppComponent().getRouter().navTo("BooksObjectPage", {
          key,
          "?query": {
            lrContext: encodedContext
          }
        });

        // URL query が失われるケースや直接再読込時のフォールバックとして同じ内容を保存する。
        // CAP 側へ渡す本命は ObjectPageExt.onBeforeRebindSchedules で作る `$filter`。
        window.sessionStorage.setItem("project1.lrFilters", encodedFilters);
        window.sessionStorage.setItem("project1.lrContext", encodedContext);
        // 標準遷移を止め、検索条件付きURLでObject Pageへ遷移する。
        return true;
      }
    }
  }
});
