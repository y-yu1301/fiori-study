import ControllerExtension from "sap/ui/core/mvc/ControllerExtension";
import Event from "sap/ui/base/Event";
import { readSearchCondition, STORAGE_KEY } from "./SearchCondition";

type ExtensionApi = {
  getFilters(): {
    filters?: unknown;
    conditions?: Record<string, unknown[]>;
    filterConditions?: Record<string, unknown[]>;
  };
};

type ControllerThis = {
  base: {
    getExtensionAPI(): ExtensionApi;
  };
};

export default ControllerExtension.extend("f.retry.edit.ui.ext.controller.ListReportExt", {
  /**
   * List Reportの検索READ直前に、実際のFilterを単純なDTOへ変換して保存します。
   * 保存した条件は、Object PageでHTTP Headerと本文Table Filterの両方に使われます。
   * つまりFでは二重経路を意図的に残しています。
   */
  onBeforeRebindWorkItems: function (this: ControllerThis, event: Event): void {
    const api = this.base.getExtensionAPI();
    const condition = readSearchCondition(api.getFilters(), event);

    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(condition));
    console.info("[f-retry-edit] Stored List Report search condition.", condition);
  }
});
