sap.ui.define([
  "sap/fe/core/AppComponent"
], function (AppComponent) {
  "use strict";

  /**
   * アプリDのコンポーネント。
   *
   * ここには何も足していません。それが今回のポイントです。
   *
   * アプリC では「List Report の検索条件を sessionStorage に保存し、Object Page で読み直す」
   * 方式だったため、起動時に前回条件を消す後始末がここに必要でした。
   * アプリD は条件を prepareBulkEdit の引数として1回渡すだけなので、
   * ブラウザに状態を残しません＝消して回る処理も要りません。
   */
  return AppComponent.extend("d.bulk.edit.ui.Component", {
    metadata: {
      manifest: "json"
    }
  });
});
