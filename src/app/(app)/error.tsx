"use client";

/**
 * ログイン後の画面で想定外のエラーが起きたときの表示（Next.js の error.tsx）。
 * 共通レイアウト（サイドバー・ヘッダー）は残したまま、この部分だけを置き換える
 */
import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="mx-auto max-w-md space-y-3 py-10 text-center">
      <h1 className="text-xl font-semibold tracking-tight">
        エラーが発生しました
      </h1>
      <p className="text-sm text-muted-foreground">
        処理を完了できませんでした。時間をおいてもう一度お試しください。
        解決しない場合は管理者に連絡してください。
      </p>
      {error.digest && (
        <p className="text-xs text-muted-foreground">
          エラー ID: {error.digest}
        </p>
      )}
      <div className="flex justify-center gap-2">
        <Button onClick={() => retry()}>もう一度試す</Button>
        <Link
          href="/"
          className="inline-flex items-center text-sm underline underline-offset-4"
        >
          トップへ戻る
        </Link>
      </div>
    </div>
  );
}
