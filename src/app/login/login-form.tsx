"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { login, type LoginState } from "@/lib/auth/actions";
import { ROLE_LABELS, type Role } from "@/lib/auth/permissions";

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
  const [state, formAction, pending] = useActionState<LoginState, FormData>(
    login,
    {},
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div className="space-y-6">
      <form
        action={formAction}
        className="space-y-4 rounded-xl border bg-card p-5 shadow-xs"
      >
        <input type="hidden" name="callbackUrl" value={callbackUrl} />
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
            aria-invalid={state.error ? true : undefined}
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
            aria-invalid={state.error ? true : undefined}
            className={inputClass}
          />
        </div>
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
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
