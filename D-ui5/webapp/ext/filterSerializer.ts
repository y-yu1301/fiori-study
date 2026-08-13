/**
 * List Report の絞り込み条件（sap.ui.model.Filter）を、サーバへ渡す JSON へ変換する処理。
 *
 * ここは「純粋な変換関数」だけを置く場所です。
 * 画面も通信もストレージも触らないので、入力と出力だけを見れば正しさが判断できます。
 *
 * ------------------------------------------------------------------------
 * 出力する JSON（CAP 側の CriteriaTranslator.java がそのまま解釈します）
 * ------------------------------------------------------------------------
 *   単一条件 : { "kind":"cond", "path":"status", "operator":"EQ", "value1":"SUBMITTED" }
 *   範囲     : { "kind":"cond", "path":"requestDate", "operator":"BT",
 *                "value1":"2026-01-01", "value2":"2026-06-30" }
 *   結合     : { "kind":"group", "and":true, "filters":[ ... ] }
 *
 * ------------------------------------------------------------------------
 * 設計方針
 * ------------------------------------------------------------------------
 * ・想定外の形が来たら **例外を投げます**。握りつぶして「条件なし＝全件」にすると、
 *   ユーザーの意図しない大量更新につながるためです。
 * ・UI5 の Filter は「複合フィルタ（aFilters を持つ）」と「単一フィルタ（sPath を持つ）」の
 *   2種類しかないので、その2つを再帰的に辿るだけで全体を変換できます。
 */

/** CAP 側で許可している演算子。これ以外は変換時に例外にします。 */
export const SUPPORTED_OPERATORS = [
  "EQ", "NE", "GT", "GE", "LT", "LE", "BT", "Contains", "StartsWith", "EndsWith"
] as const;

export type CriteriaOperator = (typeof SUPPORTED_OPERATORS)[number];

export type CriteriaValue = string | number | boolean;

export interface CriteriaCondition {
  kind: "cond";
  path: string;
  operator: CriteriaOperator;
  value1: CriteriaValue;
  value2?: CriteriaValue;
}

export interface CriteriaGroup {
  kind: "group";
  and: boolean;
  filters: CriteriaNode[];
}

export type CriteriaNode = CriteriaCondition | CriteriaGroup;

/**
 * UI5 の Filter オブジェクトの中身（プライベートプロパティ）。
 * 公開 API に getPath() などが無いバージョンもあるため、実体のプロパティを直接読みます。
 */
interface RawFilter {
  // 複合フィルタの場合
  aFilters?: RawFilter[];
  bAnd?: boolean;
  // 単一フィルタの場合
  sPath?: string;
  sOperator?: string;
  oValue1?: unknown;
  oValue2?: unknown;
}

/**
 * 絞り込み条件を JSON AST へ変換します。
 *
 * @param input Filter の配列 / 単一の Filter / undefined（＝条件なし）
 * @returns 条件が1つも無ければ null。あれば1つのノード。
 * @throws 想定外の形・未対応の演算子・値が無い条件があった場合
 */
export function serializeFilters(input: unknown): CriteriaNode | null {
  if (input === undefined || input === null) {
    return null;
  }

  if (Array.isArray(input)) {
    // FilterBar の各項目の条件が配列で渡ってくるケース。項目どうしは AND。
    const children = input
      .map((filter) => serializeFilters(filter))
      .filter((node): node is CriteriaNode => node !== null);
    return wrapGroup(children, true);
  }

  if (typeof input !== "object") {
    throw new Error(
      `絞り込み条件の形式を解釈できません（object でも配列でもありません: ${typeof input}）。`
    );
  }

  const raw = input as RawFilter;

  // --- 複合フィルタ（and / or でまとめられたもの）-----------------------------
  if (Array.isArray(raw.aFilters)) {
    const children = raw.aFilters
      .map((child) => serializeFilters(child))
      .filter((node): node is CriteriaNode => node !== null);
    // UI5 の Filter は bAnd === true のときだけ AND。未指定・false は OR です。
    return wrapGroup(children, raw.bAnd === true);
  }

  // --- 単一フィルタ -----------------------------------------------------------
  if (typeof raw.sPath === "string" && typeof raw.sOperator === "string") {
    return toCondition(raw);
  }

  // ここに来るのは、UI5 のバージョン差などで想定外の構造だった場合です。
  // 黙って無視すると「絞り込んだはずなのに全件が対象」になるため、必ず失敗させます。
  throw new Error(
    "絞り込み条件の形式を解釈できません（Filter として認識できないオブジェクトです）。"
  );
}

/** 単一フィルタを cond ノードへ。 */
function toCondition(raw: RawFilter): CriteriaCondition {
  const operator = raw.sOperator as CriteriaOperator;

  if (!SUPPORTED_OPERATORS.includes(operator)) {
    // 例：NotContains, Any, All など。サーバも受け付けないので、ここで止めます。
    throw new Error(`未対応の演算子です: ${raw.sOperator}（項目: ${raw.sPath}）`);
  }

  const value1 = normalizeValue(raw.oValue1);
  if (value1 === undefined) {
    throw new Error(`条件の値が空です（項目: ${raw.sPath}, 演算子: ${operator}）`);
  }

  const condition: CriteriaCondition = {
    kind: "cond",
    path: raw.sPath as string,
    operator,
    value1
  };

  if (operator === "BT") {
    const value2 = normalizeValue(raw.oValue2);
    if (value2 === undefined) {
      throw new Error(`BT（範囲）の2つ目の値が空です（項目: ${raw.sPath}）`);
    }
    condition.value2 = value2;
  }

  return condition;
}

/**
 * 値をサーバへ渡せる形（文字列・数値・真偽値）に整えます。
 *
 * Date が来るのは日付フィルタの場合です。ISO の日付文字列（yyyy-MM-dd）にします。
 * 時刻を含む場合は ISO 全体を送ります（サーバ側の項目型に合わせて解釈されます）。
 */
function normalizeValue(value: unknown): CriteriaValue | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (value instanceof Date) {
    const hasTime =
      value.getHours() !== 0 ||
      value.getMinutes() !== 0 ||
      value.getSeconds() !== 0 ||
      value.getMilliseconds() !== 0;
    return hasTime ? value.toISOString() : toLocalDateString(value);
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  throw new Error(`条件の値の型を解釈できません: ${Object.prototype.toString.call(value)}`);
}

/** Date をローカル日付のまま yyyy-MM-dd にします（toISOString だと時差でずれるため）。 */
function toLocalDateString(value: Date): string {
  const y = value.getFullYear();
  const m = `${value.getMonth() + 1}`.padStart(2, "0");
  const d = `${value.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 子ノードをまとめます。
 * 0件なら null（＝条件なし）、1件なら入れ子を作らずそのまま返して JSON を素直にします。
 */
function wrapGroup(children: CriteriaNode[], and: boolean): CriteriaNode | null {
  if (children.length === 0) {
    return null;
  }
  if (children.length === 1) {
    return children[0];
  }
  return { kind: "group", and, filters: children };
}
