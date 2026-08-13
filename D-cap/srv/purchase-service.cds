// =============================================================================
// PurchaseService ― 購買申請そのものを提供する「素の」サービス
// -----------------------------------------------------------------------------
// このサービスは “元データを普通に読む/直す” ための入口です。
// 一括編集の仕組み（セッション／アクション）は一切含みません。
//
// 【なぜ画面はこちらを使わないのか】
//   アプリDの画面（D-ui5）は List Report と Object Page を1つの FE アプリに同居させ、
//   List Report から unbound action `prepareBulkEdit` を呼びます。
//   Fiori Elements の1アプリは1つの OData サービス（既定モデル）にバインドされるため、
//   「List Report は PurchaseService、Object Page は BulkEditService」という
//   サービスまたぎの構成は標準機能では組めません。
//   そこで画面用には BulkEditService 側にも PurchaseRequests を投影してあり、
//   画面はすべて BulkEditService を見ます。
//   このファイルは「一括編集と無関係に元データを扱いたい他システム向けAPI」の位置づけです。
//   （詳しくは README の「確認したい点」を参照）
// =============================================================================
using { sample.procurement as db } from '../db/schema';

service PurchaseService @(requires: 'authenticated-user') {

  // 一括編集を通さない、通常の1件ずつの読み書き用
  entity PurchaseRequests as projection on db.PurchaseRequests;
}
