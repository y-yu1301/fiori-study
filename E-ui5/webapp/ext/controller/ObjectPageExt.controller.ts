import ControllerExtension from "sap/ui/core/mvc/ControllerExtension";

type ODataModel = {
  changeHttpHeaders(headers: Record<string, string | undefined>): void;
};

type ControllerThis = {
  base: {
    getAppComponent(): {
      getModel(): ODataModel;
    };
  };
};

const STORAGE_KEY = "e.header.edit.searchCondition";
const HEADER_NAME = "X-Search-Condition";

/**
 * Object Page開始時の保険として、Binding前に同じHeaderを設定します。
 * 通常遷移ではListReportExtが先に設定済みですが、ここにも置くことで責務が明確になります。
 * タイマー、再Binding、リトライ処理はありません。
 */
function applySearchConditionHeader(controller: ControllerThis): void {
  const json = sessionStorage.getItem(STORAGE_KEY);

  controller.base.getAppComponent().getModel().changeHttpHeaders({
    [HEADER_NAME]: json ? encodeURIComponent(json) : undefined
  });
}

export default ControllerExtension.extend("e.header.edit.ui.ext.controller.ObjectPageExt", {
  override: {
    routing: {
      onBeforeBinding: function (this: ControllerThis): void {
        applySearchConditionHeader(this);
      }
    }
  }
});
