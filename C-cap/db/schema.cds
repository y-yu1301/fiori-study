namespace c.filter.edit;

using { cuid, managed } from '@sap/cds/common';

/**
 * List ReportにもObject Pageにも表示する、同じ編集対象レコード。
 */
entity Campaigns : cuid, managed {
  name            : String(120);
  keyword         : String(80);
  targetDate      : Date;
  status          : String(20);
  assignee        : String(80);
  plannedQuantity : Integer;
  actualQuantity  : Integer;
  comment         : String(255);

  /**
   * Before READで$filterを読んで加工した結果を入れるvirtual項目。
   * DBには保存されません。画面・ログで「Beforeで条件を読めている」ことを確認するための項目です。
   */
  virtual filterNote : String(255);
}
