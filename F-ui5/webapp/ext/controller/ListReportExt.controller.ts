import ControllerExtension from "sap/ui/core/mvc/ControllerExtension";
import Event from "sap/ui/base/Event";
import { readSearchCondition, STORAGE_KEY } from "./SearchCondition";
import { dumpFilter, logStep } from "./debugLog";

type ExtensionApi = {
  getFilters(): {
    filters?: unknown;
    conditions?: Record<string, unknown[]>;
    filterConditions?: Record<string, unknown[]>;
  };
};

type ControllerThis = {
  base: {
    getExtensionAPI(): ExtensionApi;
  };
};

/**
 * ============================================================================
 * List Report 側の役割 ― 「条件を書き出す」だけ
 * ============================================================================
 *
 * このファイルがやること／やらないこと
 *
 *   やる  : そのREADに実際に使われたFilterを、DTOへ変換して sessionStorage へ保存する
 *   やらない: HTTP Headerの設定（Object Page側の担当）
 *   やらない: List Report自身の検索へ条件を足す（標準の $filter がそのまま使われる）
 *
 * ----------------------------------------------------------------------------
 * アプリ全体の実行順序（このファイルは①だけ）
 * ----------------------------------------------------------------------------
 *   ① beforeRebindTable（このファイル）
 *        Filter → DTO → sessionStorage へ保存
 *        ↓
 *      List Report の一覧 READ（標準の $filter で実行）
 *        ↓ CAP: @After READ WorkItems も発火する（★下の注意参照）
 *        ↓
 *   ② 行クリック → Object Page へ標準Navigation
 *        ↓
 *   ③ ObjectPageExt#onBeforeBinding
 *        sessionStorage → HTTP Header（X-Search-Condition）を設定（リトライあり）
 *        ↓
 *      ルート READ  → CAP: @After READ WorkItems が virtual項目を詰める（ヘッダー側の表示）
 *        ↓
 *   ④ ObjectPageExt#onBeforeRebindBulkItems
 *        sessionStorage → $filter を再生成して明細Bindingへ追加
 *        ↓
 *      明細 READ  → CAP: @On READ WorkItemBulkItems（明細側の表示）
 *
 * ----------------------------------------------------------------------------
 * ★注意：ここで書き出した条件は「次にObject Pageを開くとき」に使われる
 * ----------------------------------------------------------------------------
 * sessionStorage は単一キーなので、常に「最後に検索した条件」だけが残ります。
 * Object Page 側は開くたびにその1件を読むため、
 * 「List Report で条件Aで検索 → 行を開く → 戻って条件Bで検索 → 別の行を開く」
 * という操作では、意図どおり条件Bが使われます。
 *
 * ----------------------------------------------------------------------------
 * ★注意：このファイルでは HTTP Header を削除していない（Fが再現する方式の性質）
 * ----------------------------------------------------------------------------
 * ヘッダーは Object Page で設定されたあと、そのまま共有ODataModelに残り続けます。
 * そのため Object Page から戻って再検索すると、List Report の一覧 READ にも
 * 「前回の」ヘッダーが付いた状態で飛び、CAP の @After READ WorkItems が
 * 一覧の各行に古い virtual 値を詰めます。
 *
 * 一覧では virtual項目を表示していないので画面上は無害ですが、
 * その値は ODataModel のキャッシュに残ります。Object Page のルートが
 * その行Contextを引き継いだ場合、ヘッダー側に古い条件が表示される原因になります。
 * （アプリE では、ここで changeHttpHeaders により明示的にヘッダーを消しています）
 */
export default ControllerExtension.extend("f.retry.edit.ui.ext.controller.ListReportExt", {
  /**
   * List Reportの検索READ直前に、実際のFilterを単純なDTOへ変換して保存します。
   * 保存した条件は、Object PageでHTTP Headerと本文Table Filterの両方に使われます。
   * つまりFでは二重経路を意図的に残しています。
   *
   * ★なぜ「検索ボタンのハンドラ」ではなく beforeRebindTable で拾うのか
   *   ここは「これから飛ぶREADに実際に使われるFilter」が確定している唯一の場所です。
   *   検索ボタン側で FilterBar の入力値を読むと、FEが正規化・変換した後の値
   *   （セマンティック日付の展開、Navigation由来の条件など）とずれる可能性があります。
   *   一覧が実際に表示している集合と、Object Page が編集する集合を一致させたいので、
   *   READ に使われる Filter そのものを条件の出どころにしています。
   */
  onBeforeRebindWorkItems: function (this: ControllerThis, event: Event): void {
    // ------------------------------------------------------------------------
    // 【値の取得元1】ExtensionAPI ― 画面（FilterBar）の「今の状態」
    // ------------------------------------------------------------------------
    // this.base は FE が用意した本体コントローラで、getExtensionAPI() が
    // 拡張から触ってよい公開APIを返します（FE内部コントロールを byId() で掴むのは
    // バージョン更新で壊れるため、必ずこの公開API経由で取ります）。
    //
    // api.getFilters() の戻り値は UI5 / FE の版によって形が変わります。
    //   ・{ filters: Filter[] , search: string } … 一般的
    //   ・Filter 単体                            … 条件が1つのとき
    //   ・{ conditions: {...} } / { filterConditions: {...} } … Condition Map 形式
    // 「必ず配列で来る」と決めつけると版差で拾えなくなるので、
    // 形の判定は SearchCondition.ts 側に寄せています。
    const api = this.base.getExtensionAPI();
    const filterInfo = api.getFilters();

    // ------------------------------------------------------------------------
    // 【値の取得元2】event ― 「これから飛ぶREAD」に実際に使われるBinding情報
    // ------------------------------------------------------------------------
    // beforeRebindTable のイベントには、次のパラメータが載っています。
    //   event.getParameter("bindingParams")          … これから使う Binding の設定
    //                                                  （filters / sorter / parameters）
    //   event.getParameter("collectionBindingInfo")  … 上記の新しい呼び名（版により片方だけ）
    // ここに入っている filters が「実際にサーバへ送られる条件」です。
    // FilterBar の入力値ではなく、FEが正規化した後の値である点が重要です
    // （例：セマンティック日付「今月」は、この時点で具体的な日付範囲へ展開済み）。
    //
    // ★このオブジェクトは書き換え可能で、ここに filters を push すると
    //   そのREADに条件を追加できます（Object Page 側でやっているのがそれです）。
    //   List Report では追加せず、読み取るだけにしています。
    logStep("①LR beforeRebindTable", "加工前: event.bindingParams", event.getParameter("bindingParams"));
    logStep("①LR beforeRebindTable", "加工前: event.collectionBindingInfo", event.getParameter("collectionBindingInfo"));
    logStep("①LR beforeRebindTable", "加工前: api.getFilters() の生の戻り値", filterInfo);
    // Filter オブジェクトのままでは中身が読めないので、path/operator/value へ展開して出します。
    logStep("①LR beforeRebindTable", "加工前: Filter を展開したもの", dumpFilter(filterInfo.filters));

    // ------------------------------------------------------------------------
    // 【加工】UI5 の Filter → 業務DTO（location / fromDate / toDate / status）
    // ------------------------------------------------------------------------
    // event 側（そのREADに使われるBinding情報）を優先し、取れないときだけ
    // api.getFilters()（FilterBarの現在状態）へフォールバックします。
    // 形の揺れ（配列 / 単一Filter / Condition Map）の吸収は SearchCondition.ts に集約。
    const condition = readSearchCondition(filterInfo, event);

    // ★ここを見れば「拾えたか／拾えなかったか」が一目で分かります。
    //   期待した項目が undefined のままなら、原因は次のどれかです。
    //     ・SearchCondition#applyFilter が対応していない演算子だった
    //     ・項目名（sPath）が想定と違う
    //     ・そもそも FilterBar に条件が入っていない
    logStep("①LR beforeRebindTable", "加工後: 保存するDTO", condition);
    if (Object.keys(condition).length === 0) {
      // 空DTOは「全件が編集対象になる」ことを意味するため、詳細ログがオフでも警告します。
      console.warn("[f-retry-edit] 検索条件を1つも取り出せませんでした（Object Pageは全件を対象にします）。");
    }

    // ------------------------------------------------------------------------
    // 【保存】ここが「条件の唯一の書き込み口」
    // ------------------------------------------------------------------------
    // 以降このキーは読み取り専用として扱います
    // （Object Page 側の2箇所は load するだけで、書き換えません）。
    //
    // ★コンソールから中身を直接確認できます:
    //     JSON.parse(sessionStorage.getItem("f.retry.edit.searchCondition"))
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(condition));
    console.info("[f-retry-edit] Stored List Report search condition.", condition);
  }
});
