sap.ui.define([
  "sap/fe/core/AppComponent"
], function (AppComponent) {
  "use strict";

  return AppComponent.extend("c.filter.edit.ui.Component", {
    metadata: {
      manifest: "json"
    },

    init: function () {
      /*
       * sessionStorage is intentionally used only as an in-app handover from the
       * List Report table rebind to the Object Page table rebind.
       *
       * A browser hard reload keeps sessionStorage alive. If we do not clear it
       * when the app starts, an Object Page opened after reload can reuse a
       * previous List Report filter and show stale bulk-edit rows.
       */
      window.sessionStorage.removeItem("c.filter.edit.currentSearchContext");
      AppComponent.prototype.init.apply(this, arguments);
    }
  });
});
