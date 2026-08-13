namespace e.header.edit;

using { cuid, managed } from '@sap/cds/common';

/**
 * List ReportとObject Page本文テーブルが共通で扱う業務データです。
 * SearchContextを永続化するEntityは作りません。
 */
entity WorkItems : cuid, managed {
  name            : String(120);
  location        : String(40);
  businessDate    : Date;
  status          : String(20);
  assignee        : String(80);
  plannedQuantity : Integer;
  actualQuantity  : Integer;
  comment         : String(255);

  // Object Pageヘッダー表示用。DB列ではなく、CAPのAfter READでHeaderから生成します。
  virtual searchLocation : String(80);
  virtual searchPeriod   : String(80);
  virtual searchStatus   : String(40);
}
