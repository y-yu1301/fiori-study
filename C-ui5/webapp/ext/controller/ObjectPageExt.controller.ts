import ControllerExtension from "sap/ui/core/mvc/ControllerExtension";
import Filter from "sap/ui/model/Filter";
import Event from "sap/ui/base/Event";

type PlainFilter = {
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

type CollectionBindingInfo = {
  addFilter(filter: Filter): void;
};

const SEARCH_CONTEXT_STORAGE_KEY = "c.filter.edit.currentSearchContext";

function parseSearchContext(encoded: string): SearchContext {
  const searchContext = JSON.parse(encoded) as SearchContext;

  if (!Array.isArray(searchContext.filters)) {
    throw new Error("[c-filter-edit] Invalid List Report search context: filters must be an array.");
  }

  return searchContext;
}

function readSearchContext(): SearchContext {
  const encoded = sessionStorage.getItem(SEARCH_CONTEXT_STORAGE_KEY);

  if (!encoded) {
    console.error("[c-filter-edit] Missing List Report search context. The bulk table will be bound with a no-hit guard filter.");
    return {
      filters: [{
        path: "keyword",
        operator: "EQ",
        value1: "__missing_list_report_search_context__"
      }],
      search: "",
      summary: "missing List Report search context",
      updatedAt: new Date().toISOString()
    };
  }

  return parseSearchContext(encoded);
}

function createUi5Filters(searchContext: SearchContext): Filter[] {
  const filters = searchContext.filters.map((filter) => {
    return new Filter({
      path: filter.path,
      operator: filter.operator,
      value1: filter.value1,
      value2: filter.value2
    });
  });

  if (searchContext.search) {
    filters.push(new Filter({
      filters: [
        new Filter({ path: "name", operator: "Contains", value1: searchContext.search }),
        new Filter({ path: "keyword", operator: "Contains", value1: searchContext.search }),
        new Filter({ path: "comment", operator: "Contains", value1: searchContext.search }),
        new Filter({ path: "assignee", operator: "Contains", value1: searchContext.search })
      ],
      and: false
    }));
  }

  return filters;
}

export default ControllerExtension.extend("c.filter.edit.ui.ext.controller.ObjectPageExt", {
  /**
   * Object Page本文の一括編集テーブルREAD直前に、List Report条件を$filterとして追加します。
   * CAP Java側では CampaignBulkItems BEFORE READ の context.getCqn() に where として入ります。
   */
  onBeforeRebindEditableRows: function (event: Event): void {
    const bindingInfo = event.getParameter("collectionBindingInfo") as CollectionBindingInfo;
    const searchContext = readSearchContext();
    const filters = createUi5Filters(searchContext);

    console.info("[c-filter-edit] Rebind Object Page bulkEditItems with sessionStorage context.", searchContext);

    filters.forEach((ui5Filter) => {
      bindingInfo.addFilter(ui5Filter);
    });
  }
});
