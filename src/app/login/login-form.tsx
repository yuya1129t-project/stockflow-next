"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { ROLE_LABELS, type Role } from "@/lib/auth/permissions";
import { loginErrorMessage } from "@/lib/auth/session";

interface DemoAccount {
  email: string;
  name: string;
  role: Role;
}

const inputClass =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive";

export function LoginForm({
  callbackUrl,
  demoAccounts,
  demoPassword,
}: {
  callbackUrl: string;
  demoAccounts: DemoAccount[];
  demoPassword: string;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  // HTTP の /api/auth/sign-in/email を経由する（Better Auth の試行回数制限が効く）
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError("メールアドレスとパスワードを入力してください");
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const result = await authClient.signIn.email({
        email: trimmedEmail,
        password,
      });
      if (result.error) {
        setError(loginErrorMessage(result.error));
        setPending(false);
        return;
      }
    } catch (e) {
      setError(loginErrorMessage(e));
      setPending(false);
      return;
    }
    // callbackUrl はサーバー側（page.tsx の safeCallbackPath）で検査済みのサイト内パス。
    // 画面全体を読み込み直して、新しいセッション Cookie でサーバー側の描画をやり直す
    window.location.assign(callbackUrl);
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={handleSubmit}
        className="space-y-4 rounded-xl border bg-card p-5 shadow-xs"
      >
        <div className="space-y-1.5">
          <label htmlFor="email" className="text-sm font-medium">
            メールアドレス
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={error ? true : undefined}
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="password" className="text-sm font-medium">
            パスワード
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error ? true : undefined}
            className={inputClass}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending ? "ログイン中…" : "ログイン"}
        </Button>
      </form>

      <section className="space-y-2 rounded-xl border border-dashed p-4 text-sm">
        <h2 className="font-medium">デモ用アカウント</h2>
        <p className="text-muted-foreground">
          パスワードは共通で{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono">
            {demoPassword}
          </code>{" "}
          です。クリックすると入力欄に入ります。
        </p>
        <ul className="space-y-1.5">
          {demoAccounts.map((account) => (
            <li key={account.email}>
              <button
                type="button"
                onClick={() => {
                  setEmail(account.email);
                  setPassword(demoPassword);
                }}
                className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-0.5 rounded-lg border px-3 py-2 text-left hover:bg-muted"
              >
                <span className="font-mono text-xs break-all">
                  {account.email}
                </span>
                <span className="text-xs text-muted-foreground">
                  {account.role}（{ROLE_LABELS[account.role]}）
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
