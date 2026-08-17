import ControllerExtension from "sap/ui/core/mvc/ControllerExtension";
import Event from "sap/ui/base/Event";
import {
  appendFiltersToRebind,
  createODataFilters,
  HEADER_NAME,
  loadSearchCondition
} from "./SearchCondition";
import { dumpFilter, logStep } from "./debugLog";

type ODataModel = {
  changeHttpHeaders(headers: Record<string, string | undefined>): void;
  /** デバッグ用。いま設定されているリクエストヘッダーを読み出します。 */
  getHttpHeaders?(): Record<string, string>;
};

type BindingContext = {
  requestRefresh(groupId?: string): Promise<void>;
  /** デバッグ用。この Context が指しているパス（例: /WorkItems('...')）。 */
  getPath?(): string;
  /** デバッグ用。いまモデルに入っている値。virtual項目が届いたかの確認に使います。 */
  getObject?(): Record<string, unknown> | undefined;
};

type ControllerThis = {
  /** 新しいNavigationが始まったとき、古いタイマーを無効化するための通し番号です。 */
  _fHeaderRetryToken?: number;
  base: {
    getAppComponent(): { getModel(): ODataModel };
  };
};

const RETRY_INTERVAL_MS = 150;
const MAX_RETRY_COUNT = 40;

/**
 * ============================================================================
 * Object Page 側の役割 ― ヘッダー側と明細側は「別のリクエスト」である
 * ============================================================================
 *
 * FE の Object Page は1画面に見えますが、データの取得経路は2本あります。
 * どちらに何を詰めるのかを取り違えると、症状の切り分けができなくなります。
 *
 *   ┌─ ①ヘッダー側（ルートContext Binding）───────────────────────────┐
 *   │  GET WorkItems(<key>)?$select=...,searchLocation,searchPeriod,searchStatus │
 *   │  → CAP: @After READ WorkItems が virtual項目へ検索条件を詰める            │
 *   │  → 出どころは【HTTP Header】。$filter は使われない                        │
 *   │  → 担当メソッド: override.routing.onBeforeBinding（このファイル）         │
 *   └──────────────────────────────────────────────────────────────┘
 *   ┌─ ②明細側（bulkEditItems の相対 ListBinding）───────────────────┐
 *   │  GET WorkItems(<key>)/bulkEditItems?$filter=...&$count=true               │
 *   │  → CAP: @On READ WorkItemBulkItems が from を差し替えて集合を返す         │
 *   │  → 出どころは【HTTP Header が有ればHeader、無ければ $filter】             │
 *   │  → 担当メソッド: onBeforeRebindBulkItems（このファイル）                  │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * ----------------------------------------------------------------------------
 * 実行順序（この順に必ず並ぶ）
 * ----------------------------------------------------------------------------
 *   1. routing.onBeforeBinding      … ルートContextが画面へセットされる直前
 *        └ ここでヘッダーを設定しようとする（＝①に効かせたい）
 *   2. ルート READ が飛ぶ           … ①。1が間に合っていなければヘッダー無しで飛ぶ
 *   3. onBeforeRebindBulkItems      … ルートContext確定後に明細Bindingが組まれる
 *        └ ここで $filter を足す（＝②に効かせる）
 *   4. 明細 READ が飛ぶ             … ②
 *
 * ★1 と 2 の間隔はごく短く、しかも直前まで List Report の $batch が飛んでいます。
 *   ODataModel は未完了リクエストがある間 changeHttpHeaders() を例外にするため、
 *   1 は「間に合わないことがある」処理です。だから下の関数でリトライしています。
 *   一方 3 は 2 の完了後に走るので、②には条件が確実に届きます。
 *   → 「明細は正しいのにヘッダーだけ空／古い」という非対称は、この順序差が原因です。
 *
 * ----------------------------------------------------------------------------
 * ★なぜヘッダー側が「古い値」を表示しうるのか（設計上の弱点）
 * ----------------------------------------------------------------------------
 * ODataModel V4 のキャッシュキーは「リソースパス＋クエリオプション」です。
 * $filter はキーに入りますが、HTTP Header は入りません。
 * つまりモデルから見て「条件Aで読んだ WorkItems(123)」と
 * 「条件Bで読んだ WorkItems(123)」は同一で、再READが起きません。
 * その結果、前の条件で計算された virtual項目が表示され続けることがあります。
 *
 * 下の requestRefresh() は、この「キャッシュに効かない」性質を打ち消すための救済です。
 * 解決ではないので、ヘッダー設定が失敗し続ければ refresh も走らず表示は空のままです。
 * （この弱点を設計で消したのがアプリDの編集セッション方式です）
 *
 * ----------------------------------------------------------------------------
 * 共有OData V4 Modelに未完了リクエストがある間、changeHttpHeadersは例外になります。
 * Fではその制約を正面から解決せず、短い間隔で再試行します。
 *
 * Header設定に成功したらルートContextをrefreshし、Headerなしで先行したREADを
 * Header付きで再実行します。これが元実装の「リトライ＋再表示」に相当します。
 */
function applyHeaderWithRetry(
  controller: ControllerThis,
  context: BindingContext,
  token: number,
  attempt: number
): void {
  // 別のObject Page Navigationが始まっていた場合、古いタイマーは何もしません。
  // （リトライ中に一覧へ戻って別の行を開くと、古い条件で refresh してしまうため）
  if (controller._fHeaderRetryToken !== token) {
    return;
  }

  // ★条件を読むのは「リトライのたび」です。設定開始時に1回読んで持ち回るのではありません。
  //   リトライ中に条件が更新される経路（一覧の再検索）は無いので結果は同じですが、
  //   「sessionStorage が唯一の正」という原則をコード上でも崩さないためこの形にしています。
  const condition = loadSearchCondition();
  // 日本語などの非ASCIIはHTTP Headerへそのまま載せられないため、URIエンコードします
  // （CAP側 WorkItemsHandler#readSearchCondition が UTF-8 でデコードします）。
  const encoded = encodeURIComponent(JSON.stringify(condition));

  // 加工前（sessionStorage から読んだDTO）と加工後（実際にヘッダーへ載せる文字列）を
  // 並べて出します。CAP側のログに出る値と文字単位で突き合わせられるようにするためです。
  logStep(`③OP header (試行${attempt})`, "加工前: sessionStorage のDTO", condition);
  logStep(`③OP header (試行${attempt})`, "加工後: ヘッダーへ載せる文字列", encoded);

  // ★モデルの状態を取得する場所
  //   getAppComponent() はアプリ全体の Component、getModel() は既定のODataModel（""）です。
  //   List Report / Object Page / 明細テーブルはすべて【同じ1つのModel】を共有しています。
  //   ヘッダーはこのModel単位の設定なので、ここでの変更は以降のすべてのリクエストに効きます
  //   （＝一覧へ戻ったときも付いたままになる、という副作用の出どころ）。
  const model = controller.base.getAppComponent().getModel();

  try {
    model.changeHttpHeaders({
      [HEADER_NAME]: encoded
    });
  } catch (error) {
    if (attempt >= MAX_RETRY_COUNT) {
      console.error(
        `[f-retry-edit] Header setup failed after ${attempt} attempts.`,
        error
      );
      return;
    }

    console.warn(
      `[f-retry-edit] ODataModel is busy; retry Header setup (${attempt}/${MAX_RETRY_COUNT}).`
    );
    window.setTimeout(
      () => applyHeaderWithRetry(controller, context, token, attempt + 1),
      RETRY_INTERVAL_MS
    );
    return;
  }

  console.info(`[f-retry-edit] Header setup succeeded on attempt ${attempt}.`, condition);

  // 設定できたヘッダーを読み返します。狙ったキー名・値になっているかの確認用です。
  // （キー名を間違えるとCAP側では「ヘッダー無し」として扱われ、症状が同じになります）
  logStep("③OP header", "設定後: Model のリクエストヘッダー", model.getHttpHeaders?.());

  // refresh の前後で、ヘッダー側に表示される値がどう変わるかを見ます。
  // ここが「古い値が残っているのか、そもそも届いていないのか」を切り分ける決定的な場所です。
  //   ・refresh 前に値が入っている → 前回の条件のキャッシュ（＝古いデータ）
  //   ・refresh 前が空、後で入る   → 正常な流れ（初回READがヘッダー無しで先行しただけ）
  //   ・refresh 後も空             → CAP側でヘッダーを読めていない（Java側のログで確認）
  logStep("③OP header", "refresh前: Context のパス", context.getPath?.());
  logStep("③OP header", "refresh前: ヘッダー側の値", pickSearchFields(context.getObject?.()));

  // 初回READがHeaderなしで完了していても、ここでHeader付きのルートREADを再発行します。
  // requestRefreshはPromiseを返すため、失敗はログへ残し、無限再試行にはしません。
  //
  // ★ここが「ヘッダー側の値を実際に詰めさせる」ポイントです。
  //   changeHttpHeaders() は【これから飛ぶリクエスト】にしか効かないため、
  //   ヘッダー設定だけでは既に完了した（またはキャッシュから返された）ルートREADの
  //   virtual項目は空のまま／古いままです。
  //   refresh でキャッシュを捨てて再READさせることで、CAP の @After READ WorkItems が
  //   もう一度走り、searchLocation / searchPeriod / searchStatus が詰め直されます。
  //
  // ★代償（Fが意図的に残している課題）
  //   ・同じルートREADが2往復する（ヘッダー無し → ヘッダー有り）
  //   ・編集モード中に走らせるとDraftの状態と噛み合わない
  //   ・リトライが尽きた場合は refresh も走らないので、ヘッダー表示は空のまま
  context.requestRefresh()
    .then(() => {
      // 再READ完了後の値。ここに検索条件が入っていれば、CAPの @After READ が
      // ヘッダーを読んで詰められたということです。
      logStep("③OP header", "refresh後: ヘッダー側の値", pickSearchFields(context.getObject?.()));
    })
    .catch((error: unknown) => {
      console.error("[f-retry-edit] Object Page root refresh failed.", error);
    });
}

/**
 * ヘッダー側に表示している3項目だけを取り出します（デバッグ表示用）。
 *
 * ルートContextの getObject() は業務項目も全部入っていて量が多いため、
 * 見たい virtual項目だけに絞って出します。
 * 値が undefined なら「サーバが返していない（＝詰められていない）」、
 * 空文字なら「返ってきたが中身が無い」の区別が付きます。
 */
function pickSearchFields(data: Record<string, unknown> | undefined): Record<string, unknown> {
  return {
    searchLocation: data?.searchLocation,
    searchPeriod: data?.searchPeriod,
    searchStatus: data?.searchStatus
  };
}

export default ControllerExtension.extend("f.retry.edit.ui.ext.controller.ObjectPageExt", {
  /**
   * 【②明細側】Object Page本文TableのRebindごとに、List Report条件を標準Filterとして再注入します。
   * HeaderがCAPへ届かない通信でも、同じ条件を$filter経路で送るためのフォールバックです。
   *
   * 呼ばれるタイミング：ルートContextが確定した後、明細READが飛ぶ直前。
   * ソート・列変更・全画面切替などでTableがRebindされるたびに毎回呼ばれます。
   *
   * ★ここで足すのは $filter なので、ヘッダー側と違ってキャッシュキーに含まれます。
   *   → 条件が変われば必ず読み直されるため、明細は「古い集合」になりません。
   *   → ヘッダー側だけが古くなるのは、この違いによるものです。
   *
   * ★既存Filterは消しません（SearchCondition#appendFiltersToRebind）。
   *   FEやNavigationが付けた条件とANDで結合させます。Navigation由来の
   *   「選択した1行だけ」という制約は、CAP側で from を差し替えて外しています
   *   （WorkItemsHandler#rewriteBulkItemsQuery）。
   */
  onBeforeRebindBulkItems: function (_event: Event): void {
    // 【値の取得元】明細テーブルのBinding情報。List Report と同じイベント構造です。
    //   event.getParameter("bindingParams") / ("collectionBindingInfo")
    //     .filters    … これから $filter として送られる条件（ここへ push すると追加できる）
    //     .sorter     … 並べ替え
    //     .parameters … $select / $expand / $count など
    // Object Page では Navigation 由来の条件がすでに入っていることがあるため、
    // 追加前の中身を見ておくと「自分が足した条件」と「FEが足した条件」を区別できます。
    const before = (_event.getParameter("bindingParams")
      ?? _event.getParameter("collectionBindingInfo")) as { filters?: unknown } | undefined;
    logStep("④OP 明細 beforeRebindTable", "追加前: bindingParams.filters", dumpFilter(before?.filters));

    // 【加工】sessionStorage のDTO → UI5 Filter 配列（SearchCondition#createODataFilters）
    const condition = loadSearchCondition();
    const additions = createODataFilters(condition);
    logStep("④OP 明細 beforeRebindTable", "加工前: sessionStorage のDTO", condition);
    logStep("④OP 明細 beforeRebindTable", "加工後: 追加するFilter", dumpFilter(additions));

    // 【反映】bindingParams.filters へ push する（既存条件とANDで結合される）
    appendFiltersToRebind(_event, additions);

    // 追加後の最終形。ここに出た条件がそのまま $filter としてサーバへ飛びます。
    // ★ネットワークタブで実リクエストと突き合わせるとより確実です:
    //   Network → Filter に "bulkEditItems" と入力 → Request URL の $filter を確認
    logStep("④OP 明細 beforeRebindTable", "追加後: bindingParams.filters", dumpFilter(before?.filters));

    console.info("[f-retry-edit] Added stored condition to Object Page table Filter.", condition);
  },

  override: {
    routing: {
      /**
       * 【①ヘッダー側】ルートContextが画面へセットされる直前に呼ばれます。
       * ここでHTTP Headerを設定し、ルートREADにヘッダーを載せることを狙います。
       *
       * ★トークンで世代管理する理由
       *   リトライは非同期タイマーなので、成功する前に一覧へ戻って別の行を開くと、
       *   古いNavigation用のタイマーが生き残り、そちらの context を refresh してしまいます。
       *   Navigationごとに番号を進め、最新でないタイマーは何もせず終わるようにしています。
       *
       * ★このメソッドは「値を詰める場所」ではありません
       *   ヘッダー側に表示される searchLocation / searchPeriod / searchStatus を
       *   実際に詰めるのはCAPの @After READ WorkItems です。
       *   ここは「その READ にヘッダーを載せる」ための準備だけを行います。
       *   準備が間に合わなければ、詰める材料が無いまま READ が完了します。
       */
      onBeforeBinding: function (this: ControllerThis, context: BindingContext): void {
        // 【値の取得元】context = これから画面にセットされるルートContext。
        //   getPath()   … 開こうとしている1件のパス（キーがここに入っています）
        //   getObject() … この時点でモデルに入っている値
        //
        // ★getObject() がこの時点で「既に値を持っている」場合、そのデータは
        //   List Report が読んだものを引き継いでいます（新しいREADは飛んでいません）。
        //   searchLocation などに前回の条件が残っていたら、それが古い表示の正体です。
        logStep("③OP onBeforeBinding", "開くContextのパス", context.getPath?.());
        logStep("③OP onBeforeBinding", "この時点でモデルにある値（一覧から引き継いだ分）",
          pickSearchFields(context.getObject?.()));

        const token = (this._fHeaderRetryToken ?? 0) + 1;
        this._fHeaderRetryToken = token;
        applyHeaderWithRetry(this, context, token, 1);
      }
    }
  }
});
