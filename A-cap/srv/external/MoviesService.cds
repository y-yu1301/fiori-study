/*
 * =============================================================================
 * A-cap/srv/external/MoviesService.cds
 *   ―  別サービス B(MoviesService) の「外部定義」（A から消費するための型）
 * -----------------------------------------------------------------------------
 * 【これは何か】
 *   本来は `cds import`（cds-dk）が B の $metadata(edmx) から自動生成するファイルです。
 *   この学習環境では B のモデルが小さいので、同じ内容を手書きで用意しています。
 *   （将来ちゃんと自動生成したい場合は docs/09 の Step1 の `cds import` を実行）
 *
 * 【役割】
 *   A-cap が「B にどんなエンティティ・項目があるか」を知るための“型定義”。
 *   @cds.external … このサービスは A が「所有・配信」するのではなく、外部にある印。
 *   @cds.persistence.skip … A のDBにはテーブルを作らない（実体は B が持つ）。
 *
 * 【接続先】
 *   実際の通信先(URL)は application.yaml の cds.remote.services で指定します（Step2）。
 * =============================================================================
 */
@cds.external
service MoviesService {

  @cds.persistence.skip
  @readonly
  entity Movies {
    key ID     : UUID;
        // B の managed 由来（無くても最低限は動くが、型を合わせておくと安全）
        createdAt  : Timestamp;
        createdBy  : String;
        modifiedAt : Timestamp;
        modifiedBy : String;
        // B の業務項目
        title  : String;
        year   : Integer;
        genre  : String;
        rating : Decimal(2, 1);
        descr  : String;
  }
}
