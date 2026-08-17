/**
 * ============================================================================
 * 検索条件の受け渡しを目で追うためのデバッグ出力
 * ============================================================================
 *
 * 「いつ・どこで・何の値が入っていたのか」を確認するための道具です。
 * 業務ロジックは一切持っていません（消してもアプリは動きます）。
 *
 * ----------------------------------------------------------------------------
 * 使い方
 * ----------------------------------------------------------------------------
 * ブラウザの開発者ツールのコンソールで、次を実行してからリロードします。
 *
 *   sessionStorage.setItem("f.retry.edit.debug", "1"); location.reload();
 *
 * 止めるとき：
 *
 *   sessionStorage.removeItem("f.retry.edit.debug"); location.reload();
 *
 * コンソールのフィルタ欄に `[f-retry-edit]` と入れると、この一連の出力だけが残ります。
 *
 * ----------------------------------------------------------------------------
 * なぜ「既定でオフ」なのか
 * ----------------------------------------------------------------------------
 * 加工前の値（UI5 の Filter オブジェクトそのもの）は入れ子が深く量も多いため、
 * 常時出すとコンソールが埋まって肝心の順序が読めなくなります。
 * 通常運転で必要な最小限（条件の保存・ヘッダー設定の成否）は
 * 各コントローラの console.info でオフでも出るようにしてあり、
 * このモジュールは「詳細を見たいときだけ」有効にします。
 */

/** sessionStorage のこのキーに値が入っていると詳細ログが出ます。 */
const DEBUG_KEY = "f.retry.edit.debug";

/** すべてのログに付ける目印。コンソールのフィルタに使います。 */
const LOG_PREFIX = "[f-retry-edit]";

/** 詳細ログが有効かどうか。判定に失敗しても例外にしない（privateモード等でも安全）。 */
export function debugEnabled(): boolean {
  try {
    return Boolean(sessionStorage.getItem(DEBUG_KEY));
  } catch {
    return false;
  }
}

/**
 * 処理の1ステップを出力します。
 *
 * @param step  実行順序が分かるようにした見出し（例: "①LR beforeRebindTable"）
 * @param label そのステップの中で何の値なのか（例: "加工前: event の Filter"）
 * @param data  値そのもの。オブジェクトはコンソールで展開して中身を見られます
 *
 * 順序の追跡が目的なので、必ず step → label → data の順で書き出します。
 * 「加工前」「加工後」を同じ step で2回出すと、変換の前後を並べて比較できます。
 */
export function logStep(step: string, label: string, data?: unknown): void {
  if (!debugEnabled()) {
    return;
  }
  if (data === undefined) {
    console.info(`${LOG_PREFIX} ${step} | ${label}`);
    return;
  }
  console.info(`${LOG_PREFIX} ${step} | ${label}`, data);
}

/**
 * UI5 の Filter オブジェクトを、コンソールで読める素のデータへ変換します。
 *
 * ----------------------------------------------------------------------------
 * なぜこれが必要なのか
 * ----------------------------------------------------------------------------
 * sap/ui/model/Filter は内部プロパティに値を持っており、そのまま console.log すると
 * 入れ子の Filter が並ぶだけで「どの項目に何の条件が付いているか」が読めません。
 * 見たいのは実質つぎの4つだけです。
 *
 *   sPath     … 対象の項目名（例: "businessDate"）
 *   sOperator … 演算子（例: "BT" = BETWEEN, "EQ", "GE", "LE"）
 *   oValue1   … 1つ目の値（BT なら開始値）
 *   oValue2   … 2つ目の値（BT の終了値。他の演算子では undefined）
 *   aFilters  … 子Filter。AND/OR で束ねられている場合はここに入る（入れ子になる）
 *
 * この関数は上記を再帰的に取り出して、
 *   { path: "businessDate", operator: "BT", value1: "2026-08-01", value2: "2026-08-31" }
 * のような形にします。実装側（SearchCondition#applyFilter）が読んでいるのと
 * 同じプロパティを見ているので、「なぜ拾えなかったのか」の調査に直接使えます。
 */
export function dumpFilter(filter: unknown): unknown {
  if (!filter || typeof filter !== "object") {
    return filter;
  }

  if (Array.isArray(filter)) {
    return filter.map(dumpFilter);
  }

  // sap/ui/model/Filter の内部プロパティを構造として宣言します
  // （公式に getter が無いため、実装側と同じ読み方をしています）。
  const raw = filter as {
    aFilters?: unknown[];
    bAnd?: boolean;
    sPath?: string;
    sOperator?: string;
    oValue1?: unknown;
    oValue2?: unknown;
  };

  // 子を持つ Filter（AND/OR で束ねたもの）は、束ね方と子の一覧を出します。
  if (Array.isArray(raw.aFilters)) {
    return {
      combine: raw.bAnd === false ? "OR" : "AND",
      children: raw.aFilters.map(dumpFilter)
    };
  }

  // 末端の Filter（実際の1条件）
  return {
    path: raw.sPath,
    operator: raw.sOperator,
    value1: raw.oValue1,
    value2: raw.oValue2,
    // Date が入っている場合、そのままだと表示がローカル時刻になって分かりにくいので型も出します。
    value1Type: raw.oValue1 instanceof Date ? "Date" : typeof raw.oValue1
  };
}
