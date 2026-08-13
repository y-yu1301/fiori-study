import MessageBox from "sap/m/MessageBox";
import { serializeFilters, CriteriaNode } from "./filterSerializer";

/**
 * List Report の「まとめて編集」ボタンの処理。
 *
 * ------------------------------------------------------------------------
 * やっていること（3ステップだけ）
 * ------------------------------------------------------------------------
 *   1. いま画面に効いている絞り込み条件と検索語を取得する
 *   2. それを JSON へ変換して prepareBulkEdit アクションに渡す
 *   3. サーバが作った編集セッションの Object Page へ、FE が自動遷移する
 *
 * ------------------------------------------------------------------------
 * やっていないこと（アプリC の反省点）
 * ------------------------------------------------------------------------
 *   × sessionStorage / localStorage に条件を保存する
 *   × ODataModel#changeHTTPHeaders() で条件を HTTP ヘッダーに埋める
 *   × beforeRebindTable で条件を読み直して明細を絞り込む
 *   × 条件が取れなかったときに「とりあえず全件」で続行する
 *
 * 条件をサーバへ渡すのは、このファイルの invokeAction の一度きりです。
 * 以降の画面（Object Page）は Sessions(ID) を開くだけなので、
 * リロードしてもブックマークしても同じ内容が表示されます。
 */

/** 1回の一括編集で扱える最大件数。★CAP 側 application.yaml の bulk-edit.max-items と必ず揃えること。 */
const MAX_ITEMS = 500;

/** 呼び出すアクションの完全名（サービス名 + アクション名）。 */
const ACTION_NAME = "BulkEditService.prepareBulkEdit";

/** ログの目印。ブラウザのコンソールで絞り込むときに使います。 */
const LOG_PREFIX = "[d-bulk-edit]";

// ---------------------------------------------------------------------------
// Fiori Elements が渡してくる API の形（必要な分だけ宣言）
// ---------------------------------------------------------------------------
/** アクション実行後に返ってくる OData V4 の Context（必要なメソッドだけ） */
interface ODataV4Context {
  getObject(): Record<string, unknown> | undefined;
}

interface EditFlow {
  invokeAction(
    actionName: string,
    parameters: Record<string, unknown>
  ): Promise<ODataV4Context | undefined>;
}

interface Routing {
  /** manifest.json の routes 定義（名前とパターン）へ遷移する */
  navigateToRoute(routeName: string, parameters: Record<string, unknown>): Promise<unknown>;
}

interface ODataV4ListBinding {
  requestContexts(start: number, length: number): Promise<unknown[]>;
  getCount(): number | undefined;
}

interface ODataV4Model {
  bindList(
    path: string,
    context?: unknown,
    sorters?: unknown,
    filters?: unknown,
    parameters?: Record<string, unknown>
  ): ODataV4ListBinding;
}

interface ListReportExtensionAPI {
  getFilters(): unknown;
  getEditFlow(): EditFlow;
  getRouting(): Routing;
  getModel(name?: string): ODataV4Model;
}

/** getFilters() から取り出した「今の絞り込み状態」。 */
interface CurrentFilterState {
  /** サーバへ渡す JSON AST（条件なしなら null） */
  criteria: CriteriaNode | null;
  /** フリーテキスト検索語（無ければ空文字） */
  search: string;
  /** 件数の事前確認に使う、UI5 の Filter オブジェクトそのもの */
  filterObjects: unknown[];
}

/**
 * 「まとめて編集」ボタンから呼ばれるハンドラ。
 * manifest.json の controlConfiguration → actions → press から参照されます。
 */
export async function onBulkEdit(this: unknown): Promise<void> {
  const api = resolveExtensionAPI(this);

  let state: CurrentFilterState;
  let count: number | undefined;

  // --- 1. 条件の取得と変換、件数の事前確認 ---------------------------------
  // ここで失敗したら、サーバへは一切送らずにユーザーへ理由を出します。
  try {
    state = readCurrentFilterState(api);
    console.info(`${LOG_PREFIX} criteria =`, JSON.stringify(state.criteria), "search =", state.search);
    count = await requestTargetCount(api, state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} 絞り込み条件を組み立てられませんでした。`, error);
    MessageBox.error(`絞り込み条件を読み取れませんでした。\n${message}`);
    return;
  }

  // --- 2. 件数による分岐 -----------------------------------------------------
  if (count === 0) {
    // 対象が無いのにセッションを作っても意味がないので、ここで終わります。
    MessageBox.information("絞り込み結果が0件です。条件を見直してください。");
    return;
  }

  if (count !== undefined && count > MAX_ITEMS) {
    MessageBox.error(
      `対象が ${count} 件あり、一度に編集できる上限（${MAX_ITEMS} 件）を超えています。\n` +
      "絞り込み条件を追加してください。"
    );
    return;
  }

  // 条件が空＝全件が対象。事故防止のため、件数を見せて確認します。
  if (state.criteria === null && state.search === "") {
    const label = count === undefined ? "すべての購買申請" : `全 ${count} 件`;
    const proceed = await confirm(
      `絞り込み条件が指定されていません。\n${label}が一括編集の対象になります。よろしいですか？`
    );
    if (!proceed) {
      return;
    }
  }

  // --- 3. サーバへ渡して、返ってきたセッションへ遷移 --------------------------
  //
  // ★ここで requiresNavigation: true を使っていない理由（重要）
  //
  //   FE のドキュメントには「アクションが返した Context へ遷移する」と書かれていますが、
  //   実装（sap/fe/core/controllerextensions/EditFlow.js）では遷移の判定が
  //
  //       アクションを呼んだ元の Context のメタパス === 戻り値のメタパス
  //
  //   になっています。unbound action には「呼んだ元の Context」が存在しないため、
  //   左辺が undefined となり、条件は<b>絶対に成立しません</b>。
  //   つまり requiresNavigation は bound action 専用で、
  //   「一覧から unbound action を呼んで別の画面へ飛ぶ」用途では何も起きません。
  //   （アクション自体は成功しているので、セッションだけが作られて画面が変わらない、
  //     という分かりにくい症状になります）
  //
  //   そこで、返ってきたセッションの ID を読み、routing で明示的に遷移します。
  //   navigateToRoute は manifest.json の routes 定義（SessionObjectPage）を使う公開APIです。
  let session: Record<string, unknown> | undefined;

  try {
    const result = await api.getEditFlow().invokeAction(ACTION_NAME, {
      model: api.getModel(),
      parameterValues: [
        // 条件なしのときは空文字。サーバは「条件なし」として扱います。
        { name: "criteria", value: state.criteria === null ? "" : JSON.stringify(state.criteria) },
        { name: "search", value: state.search }
      ],
      // 引数はこちらで用意済みなので、FE の入力ダイアログは出しません。
      skipParameterDialog: true
    });

    // アクションの戻り値（= 作成された Sessions 1件）を取り出します。
    session = result?.getObject();
  } catch (error) {
    // サーバ側のエラー（0件・上限超過・不正な条件など）は FE がメッセージダイアログで
    // 表示してくれます。ここでは原因調査用にコンソールへ残すだけにします。
    console.error(`${LOG_PREFIX} prepareBulkEdit の呼び出しに失敗しました。`, error);
    return;
  }

  const sessionId = session?.ID;
  if (typeof sessionId !== "string") {
    // 成功したのに ID が読めない＝想定外。黙って終わらせず必ず知らせます。
    console.error(`${LOG_PREFIX} アクションの戻り値からセッションIDを取得できませんでした。`, session);
    MessageBox.error("編集セッションは作成できましたが、画面遷移に失敗しました。");
    return;
  }

  console.info(`${LOG_PREFIX} セッション ${sessionId} へ遷移します。`);

  // Object Page のルート（manifest.json の routes[].name）へ遷移。
  // パターンは "Sessions({key}):?query:" なので、key にはキー述語の中身を渡します。
  // Draft 有効エンティティはキーが2つ（ID と IsActiveEntity）である点に注意。
  await api.getRouting().navigateToRoute("SessionObjectPage", {
    key: `ID=${sessionId},IsActiveEntity=true`
  });
}

// ===========================================================================
// 以下は補助関数
// ===========================================================================

/**
 * ハンドラの this から ExtensionAPI を取り出します。
 *
 * Fiori Elements のバージョンによって、カスタムアクションのハンドラは
 *   (a) this = ExtensionAPI そのもの
 *   (b) this = ページのコントローラ（getExtensionAPI() を持つ）
 * のどちらかで呼ばれます。両方を明示的に判定し、
 * どちらでもなければ黙って続行せずエラーにします。
 */
function resolveExtensionAPI(self: unknown): ListReportExtensionAPI {
  const candidate = self as Partial<ListReportExtensionAPI> & {
    getExtensionAPI?: () => ListReportExtensionAPI;
    base?: { getExtensionAPI?: () => ListReportExtensionAPI };
  };

  if (candidate && typeof candidate.getFilters === "function") {
    return candidate as ListReportExtensionAPI;
  }
  if (candidate && typeof candidate.getExtensionAPI === "function") {
    return candidate.getExtensionAPI();
  }
  if (candidate?.base && typeof candidate.base.getExtensionAPI === "function") {
    return candidate.base.getExtensionAPI();
  }

  console.error(`${LOG_PREFIX} ExtensionAPI を取得できませんでした。this =`, self);
  throw new Error("画面の API を取得できませんでした（Fiori Elements のバージョン差の可能性）。");
}

/**
 * いま効いている絞り込み条件と検索語を取り出します。
 *
 * ExtensionAPI#getFilters() の戻り値はバージョンにより
 *   { filters: Filter[], search: string } / Filter[] / Filter
 * のいずれかになりえます。想定外の形だったときは、
 * コンソールに実物を出したうえで例外にします（＝勝手に「条件なし」にしない）。
 */
function readCurrentFilterState(api: ListReportExtensionAPI): CurrentFilterState {
  const raw = api.getFilters();

  if (raw === undefined || raw === null) {
    // フィルタバーが空のときは undefined が返ります（＝正常な「条件なし」）。
    return { criteria: null, search: "", filterObjects: [] };
  }

  let filterObjects: unknown[];
  let search = "";

  if (Array.isArray(raw)) {
    filterObjects = raw;
  } else if (typeof raw === "object") {
    const info = raw as { filters?: unknown; search?: unknown };

    if (Array.isArray(info.filters)) {
      filterObjects = info.filters;
    } else if (info.filters) {
      filterObjects = [info.filters];
    } else if ("aFilters" in (raw as object) || "sPath" in (raw as object)) {
      // getFilters() が Filter を1つだけ返した場合
      filterObjects = [raw];
    } else {
      filterObjects = [];
    }

    if (typeof info.search === "string") {
      search = info.search;
    }
  } else {
    console.warn(`${LOG_PREFIX} getFilters() の戻り値が想定外です。`, raw);
    throw new Error("getFilters() の戻り値の形式が想定外です。");
  }

  return {
    // 変換は純粋関数（filterSerializer.ts）に任せます。
    criteria: serializeFilters(filterObjects),
    search,
    filterObjects
  };
}

/**
 * 対象件数を先に数えます（0件・上限超過を、セッションを作る前に知るため）。
 *
 * サーバ側でも同じチェックをしているので、ここは「早めに親切に知らせる」ためだけの処理です。
 * 数えられなかった場合は undefined を返し、判断はサーバに委ねます。
 */
async function requestTargetCount(
  api: ListReportExtensionAPI,
  state: CurrentFilterState
): Promise<number | undefined> {
  try {
    const parameters: Record<string, unknown> = { $count: true };
    if (state.search) {
      parameters.$search = state.search;
    }

    const binding = api.getModel().bindList(
      "/PurchaseRequests",
      undefined,
      [],
      state.filterObjects,
      parameters
    );

    // 1件だけ要求すれば $count 付きのリクエストが飛び、件数が取れます。
    await binding.requestContexts(0, 1);
    return binding.getCount();
  } catch (error) {
    console.warn(`${LOG_PREFIX} 件数の事前取得に失敗しました。判定はサーバ側に任せます。`, error);
    return undefined;
  }
}

/** MessageBox.confirm を await できる形に包みます。 */
function confirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    MessageBox.confirm(message, {
      title: "確認",
      onClose: (action: string) => resolve(action === MessageBox.Action.OK)
    });
  });
}
