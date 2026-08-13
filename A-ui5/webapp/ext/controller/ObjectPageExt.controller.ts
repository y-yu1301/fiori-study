import ControllerExtension from "sap/ui/core/mvc/ControllerExtension";
import Filter from "sap/ui/model/Filter";
import HashChanger from "sap/ui/core/routing/HashChanger";
import Event from "sap/ui/base/Event";
import JSONModel from "sap/ui/model/json/JSONModel";

/**
 * ListReportExt で作った plain object 形式の Filter。
 * Object Page 側ではこれを sap.ui.model.Filter に戻して、明細テーブルREADへ差し込みます。
 */
type PlainFilter = {
  path: string;
  operator: string;
  value1?: string | number | boolean;
  value2?: string | number | boolean;
};

type CollectionBindingInfo = {
  addFilter(filter: Filter): void;
};

/**
 * Object Page ヘッダー表示用と、明細 READ の `$filter` 再構築用をまとめたコンテキスト。
 */
type SearchContext = {
  filters: PlainFilter[];
  search: string;
  summary: string;
};

/**
 * Fiori Elements が実行時に渡す `this.base` のうち、このサンプルで使う範囲だけを型定義。
 */
type ControllerExtensionThis = {
  base: {
    getView(): {
      getModel(name: string): JSONModel | undefined;
      setModel(model: JSONModel, name: string): void;
    };
  };
};

/**
 * Object Page の hash URL から query parameter を取り出します。
 *
 * Object Page の URL は通常の server request ではなくブラウザ内 hash route なので、
 * CAP の before READ に直接は届きません。ここで画面側が読み取ってから、
 * onBeforeRebindSchedules で OData `$filter` として付け直します。
 */
function readEncodedRouteParameter(name: string): string | null {
  const hash = HashChanger.getInstance().getHash();
  const query = hash.split("?")[1] || "";

  return new URLSearchParams(query).get(name);
}

/**
 * List Report から渡された検索コンテキストを復元します。
 *
 * 優先順位:
 *   1. URL query の lrContext
 *   2. sessionStorage の project1.lrContext
 *
 * URL に残っている場合はブックマーク/共有に強く、sessionStorage は画面遷移中の保険です。
 */
function readSearchContextFromRoute(): SearchContext {
  let encoded = readEncodedRouteParameter("lrContext");

  if (!encoded) {
    encoded = window.sessionStorage.getItem("project1.lrContext");
  }

  if (!encoded) {
    return {
      filters: [],
      search: "",
      summary: ""
    };
  }

  return JSON.parse(decodeURIComponent(encoded)) as SearchContext;
}

/**
 * 明細 READ に差し込む Filter 条件だけを取り出します。
 * 新形式の lrContext.filters を優先し、古い lrFilters も読めるようにしています。
 */
function readFiltersFromRoute(): PlainFilter[] {
  const searchContext = readSearchContextFromRoute();
  let encoded = readEncodedRouteParameter("lrFilters");

  if (searchContext.filters?.length) {
    return searchContext.filters;
  }

  if (!encoded) {
    encoded = window.sessionStorage.getItem("project1.lrFilters");
  }

  return encoded ? JSON.parse(decodeURIComponent(encoded)) as PlainFilter[] : [];
}

/**
 * Object Page ヘッダーの custom facet が参照する JSONModel を更新します。
 * Fragment 側では `{searchContext>/summary}` を表示します。
 */
function updateSearchContextModel(view: { getModel(name: string): JSONModel | undefined; setModel(model: JSONModel, name: string): void }): void {
  const searchContext = readSearchContextFromRoute();
  const model = view.getModel("searchContext");

  if (!model) {
    view.setModel(new JSONModel(searchContext), "searchContext");
    return;
  }

  model.setData(searchContext);
}

export default ControllerExtension.extend("project1.ext.controller.ObjectPageExt", {
  override: {
    routing: {
      /**
       * Object Page が対象レコードに bind された後に呼ばれます。
       * このタイミングでヘッダー表示用の searchContext モデルをセットします。
       */
      onAfterBinding: function (this: ControllerExtensionThis): void {
        updateSearchContextModel(this.base.getView());
      }
    }
  },

  /**
   * Object Page 内の schedules テーブルが READ される直前に呼ばれます。
   *
   * ここで List Report から持ち込んだ PlainFilter を sap.ui.model.Filter に戻し、
   * collectionBindingInfo.addFilter(...) で追加します。
   *
   * この結果、CAP Java 側には custom parameter ではなく通常の OData `$filter` として届きます。
   */
  onBeforeRebindSchedules: function (event: Event): void {
    const bindingInfo = event.getParameter("collectionBindingInfo") as CollectionBindingInfo;
    const filters = readFiltersFromRoute();

    filters.forEach((filter) => {
      bindingInfo.addFilter(new Filter({
        path: filter.path,
        operator: filter.operator,
        value1: filter.value1,
        value2: filter.value2
      }));
    });
  }
});
