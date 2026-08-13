/**
 * このプロジェクトが使う UI5 モジュールの最小限の型定義。
 *
 * SAPUI5 の完全な型定義（@sapui5/types）を入れると依存が重くなるため、
 * 学習用としては「実際に import しているものだけ」を手書きで宣言しています。
 * （C-ui5 も同じ方針です）
 */

declare module "sap/m/MessageBox" {
  const MessageBox: {
    /** 情報ダイアログ */
    information(message: string, options?: Record<string, unknown>): void;
    /** エラーダイアログ */
    error(message: string, options?: Record<string, unknown>): void;
    /** OK / キャンセルの確認ダイアログ */
    confirm(
      message: string,
      options?: {
        title?: string;
        onClose?: (action: string) => void;
      }
    ): void;
    /** ダイアログの戻り値（OK / CANCEL など） */
    Action: {
      OK: string;
      CANCEL: string;
    };
  };
  export default MessageBox;
}
