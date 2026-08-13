namespace f.retry.edit;

using { cuid, managed } from '@sap/cds/common';

/**
 * List ReportとObject Page本文が共通で扱う業務データです。
 * 検索コンテキストを保存する追加Entityは作成しません。
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

  // Object Pageのヘッダー表示専用です。値はCAPのAfter READでHTTP Headerから設定します。
  virtual searchLocation : String(80);
  virtual searchPeriod   : String(80);
  virtual searchStatus   : String(40);
}
