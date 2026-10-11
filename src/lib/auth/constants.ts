/** 認証まわりの定数（依存のない小さなモジュール。proxy からも import する） */

/** 無効ユーザーのログインを拒否したときのエラーコード（ログイン画面で日本語に変換する） */
export const USER_INACTIVE_CODE = "USER_INACTIVE";

/** proxy（src/proxy.ts）がリクエストに付ける、表示中のパス（ログイン後に戻る先に使う） */
export const PATHNAME_HEADER = "x-stockflow-pathname";
