import ControllerExtension from "sap/ui/core/mvc/ControllerExtension";
import Event from "sap/ui/base/Event";
import {
  appendFiltersToRebind,
  createODataFilters,
  HEADER_NAME,
  loadSearchCondition
} from "./SearchCondition";

type ODataModel = {
  changeHttpHeaders(headers: Record<string, string | undefined>): void;
};

type BindingContext = {
  requestRefresh(groupId?: string): Promise<void>;
};

type ControllerThis = {
  /** 新しいNavigationが始まったとき、古いタイマーを無効化するための通し番号です。 */
  _fHeaderRetryToken?: number;
  base: {
    getAppComponent(): { getModel(): ODataModel };
  };
};

const RETRY_INTERVAL_MS = 150;
const MAX_RETRY_COUNT = 40;

/**
 * 共有OData V4 Modelに未完了リクエストがある間、changeHttpHeadersは例外になります。
 * Fではその制約を正面から解決せず、短い間隔で再試行します。
 *
 * Header設定に成功したらルートContextをrefreshし、Headerなしで先行したREADを
 * Header付きで再実行します。これが元実装の「リトライ＋再表示」に相当します。
 */
function applyHeaderWithRetry(
  controller: ControllerThis,
  context: BindingContext,
  token: number,
  attempt: number
): void {
  // 別のObject Page Navigationが始まっていた場合、古いタイマーは何もしません。
  if (controller._fHeaderRetryToken !== token) {
    return;
  }

  const condition = loadSearchCondition();
  const encoded = encodeURIComponent(JSON.stringify(condition));

  try {
    controller.base.getAppComponent().getModel().changeHttpHeaders({
      [HEADER_NAME]: encoded
    });
  } catch (error) {
    if (attempt >= MAX_RETRY_COUNT) {
      console.error(
        `[f-retry-edit] Header setup failed after ${attempt} attempts.`,
        error
      );
      return;
    }

    console.warn(
      `[f-retry-edit] ODataModel is busy; retry Header setup (${attempt}/${MAX_RETRY_COUNT}).`
    );
    window.setTimeout(
      () => applyHeaderWithRetry(controller, context, token, attempt + 1),
      RETRY_INTERVAL_MS
    );
    return;
  }

  console.info(`[f-retry-edit] Header setup succeeded on attempt ${attempt}.`, condition);

  // 初回READがHeaderなしで完了していても、ここでHeader付きのルートREADを再発行します。
  // requestRefreshはPromiseを返すため、失敗はログへ残し、無限再試行にはしません。
  context.requestRefresh().catch((error: unknown) => {
    console.error("[f-retry-edit] Object Page root refresh failed.", error);
  });
}

export default ControllerExtension.extend("f.retry.edit.ui.ext.controller.ObjectPageExt", {
  /**
   * Object Page本文TableのRebindごとに、List Report条件を標準Filterとして再注入します。
   * HeaderがCAPへ届かない通信でも、同じ条件を$filter経路で送るためのフォールバックです。
   */
  onBeforeRebindBulkItems: function (_event: Event): void {
    const condition = loadSearchCondition();
    appendFiltersToRebind(_event, createODataFilters(condition));
    console.info("[f-retry-edit] Added stored condition to Object Page table Filter.", condition);
  },

  override: {
    routing: {
      onBeforeBinding: function (this: ControllerThis, context: BindingContext): void {
        const token = (this._fHeaderRetryToken ?? 0) + 1;
        this._fHeaderRetryToken = token;
        applyHeaderWithRetry(this, context, token, 1);
      }
    }
  }
});
