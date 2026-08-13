sap.ui.define([
  "sap/fe/core/AppComponent"
], function (AppComponent) {
  "use strict";

  // sessionStorageは同一タブ内のList Report → Object Page引き継ぎにだけ利用します。
  // 検索条件の業務上の正は、Object Page通信時に設定するHTTP Headerです。
  return AppComponent.extend("e.header.edit.ui.Component", {
    metadata: {
      manifest: "json"
    }
  });
});
