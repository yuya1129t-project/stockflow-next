"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { ROLE_LABELS, ROLES, type Role } from "@/lib/auth/permissions";
import { USER_LIMITS } from "@/lib/users/schema";

import {
  changeUserRoleAction,
  resetUserPasswordAction,
  setUserActiveAction,
} from "../actions";

/**
 * ユーザーの詳細画面の操作（ロール変更・無効化／再有効化・パスワード再設定）。admin にだけ表示する。
 * 自分自身・デモ用アカウントでは操作を出さない（画面の補助。サーバー側でも必ず拒否する）
 */

function Message({ error, done }: { error?: string; done?: string }) {
  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    );
  }
  return done ? (
    <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
      {done}
    </p>
  ) : null;
}

/** ロール変更 */
export function RoleForm({ userId, role }: { userId: string; role: Role }) {
  const router = useRouter();
  const [value, setValue] = useState<Role>(role);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setDone(undefined);
    startTransition(async () => {
      const result = await changeUserRoleAction(userId, { role: value });
      if (result.ok) {
        setDone("ロールを変更しました");
        router.refresh();
      } else {
        setError(result.fieldErrors?.role?.[0] ?? result.error);
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <Label htmlFor="user-role">ロール</Label>
      <div className="flex flex-wrap gap-2">
        <NativeSelect
          id="user-role"
          value={value}
          onChange={(event) => setValue(event.target.value as Role)}
        >
          {ROLES.map((r) => (
            <NativeSelectOption key={r} value={r}>
              {ROLE_LABELS[r]}（{r}）
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button type="submit" disabled={pending || value === role}>
          {pending ? "変更中…" : "ロールを変更"}
        </Button>
      </div>
      <Message error={error} done={done} />
    </form>
  );
}

/** 無効化・再有効化（確認ダイアログあり） */
export function UserActiveToggle({
  userId,
  name,
  isActive,
}: {
  userId: string;
  name: string;
  isActive: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const next = !isActive;
  const verb = next ? "再度有効にする" : "無効にする";

  function submit() {
    setError(undefined);
    startTransition(async () => {
      const result = await setUserActiveAction(userId, next);
      if (result.ok) {
        setOpen(false);
        router.replace(`/users/${userId}`);
        router.refresh();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) setError(undefined);
      }}
    >
      <DialogTrigger
        render={<Button variant={next ? "outline" : "destructive"} />}
      >
        {verb}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>ユーザーを{verb}</DialogTitle>
          <DialogDescription>
            「{name}」を{next ? "再度有効にします" : "無効にします"}。
            {next
              ? "再びログインできるようになります。API トークンは失効したままなので、必要なら発行し直してください。"
              : "無効にするとログインできなくなり、ログイン中のセッションはすぐに終了し、API トークンもすべて失効します。操作履歴は残ります。"}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            キャンセル
          </DialogClose>
          <Button
            variant={next ? "default" : "destructive"}
            onClick={submit}
            disabled={pending}
          >
            {pending ? "処理中…" : verb}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** パスワード再設定（admin が新しいパスワードを設定する） */
export function PasswordResetForm({
  userId,
  isSelf,
}: {
  userId: string;
  isSelf: boolean;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setDone(undefined);
    startTransition(async () => {
      const result = await resetUserPasswordAction(userId, { password });
      if (result.ok) {
        setPassword("");
        setDone(
          isSelf
            ? "パスワードを再設定しました"
            : "パスワードを再設定しました。このユーザーのログイン中のセッションは終了しました",
        );
      } else {
        setError(result.fieldErrors?.password?.[0] ?? result.error);
      }
    });
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-2">
      <Label htmlFor="user-new-password">新しいパスワード</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id="user-new-password"
          type="password"
          autoComplete="new-password"
          className="w-full sm:w-64"
          maxLength={USER_LIMITS.passwordMax}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby="user-new-password-hint"
        />
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "設定中…" : "パスワードを再設定"}
        </Button>
      </div>
      <p id="user-new-password-hint" className="text-xs text-muted-foreground">
        {USER_LIMITS.passwordMin}
        文字以上。設定したパスワードは本人に伝えてください
      </p>
      <Message error={error} done={done} />
    </form>
  );
}
