sap.ui.define([
  "sap/fe/core/AppComponent"
], function (AppComponent) {
  "use strict";

  // Fは、共有OData ModelのHeader変更をリトライし、成功後にObject Pageを再読込します。
  // このタイミング依存を含めて、既存方式を再現することがサンプルの目的です。
  return AppComponent.extend("f.retry.edit.ui.Component", {
    metadata: {
      manifest: "json"
    }
  });
});
