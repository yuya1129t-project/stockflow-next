"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { USER_LIMITS } from "@/lib/users/schema";
import { cn } from "@/lib/utils";

import { issueApiTokenAction, revokeApiTokenAction } from "../actions";

/** 表示用に整えたトークン（本体・ハッシュは持たない） */
export interface ApiTokenRow {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** API トークンの発行と一覧・失効（admin のみ）。発行したトークンはこの画面で 1 回だけ表示する */
export function ApiTokensPanel({
  userId,
  tokens,
  canIssue,
}: {
  userId: string;
  tokens: ApiTokenRow[];
  /** 無効なユーザーには発行しない */
  canIssue: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [issued, setIssued] = useState<{ name: string; token: string }>();
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setIssued(undefined);
    setCopied(false);
    startTransition(async () => {
      const result = await issueApiTokenAction(userId, { name });
      if (result.ok) {
        setIssued({ name: name.trim(), token: result.token });
        setName("");
        router.refresh();
      } else {
        setError(result.fieldErrors?.name?.[0] ?? result.error);
      }
    });
  }

  async function copy(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-3">
      {canIssue && (
        <form onSubmit={submit} noValidate className="space-y-2">
          <Label htmlFor="token-name">トークンの名前</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="token-name"
              className="w-full sm:w-64"
              maxLength={USER_LIMITS.tokenName}
              placeholder="例: 在庫連携スクリプト"
              autoComplete="off"
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={error ? true : undefined}
            />
            <Button type="submit" disabled={pending}>
              {pending ? "発行中…" : "トークンを発行"}
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </form>
      )}

      {issued && (
        <div
          role="status"
          className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
        >
          <p className="font-medium">
            トークン「{issued.name}」を発行しました。この値は
            <strong>いまだけ表示します</strong>
            （画面を離れると二度と表示できません）。コピーして安全な場所に保管してください。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded bg-muted px-2 py-1 font-mono text-xs break-all">
              {issued.token}
            </code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => copy(issued.token)}
            >
              {copied ? "コピーしました" : "コピー"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            使い方: <code>Authorization: Bearer &lt;トークン&gt;</code> を付けて
            /api/v1 にリクエストします
          </p>
        </div>
      )}

      {tokens.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          発行した API トークンはありません
        </p>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名前</TableHead>
                <TableHead>作成日時</TableHead>
                <TableHead>最終使用</TableHead>
                <TableHead>状態</TableHead>
                <TableHead>
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((t) => (
                <TableRow
                  key={t.id}
                  className={cn(t.revokedAt && "text-muted-foreground")}
                >
                  <TableCell className="min-w-32 whitespace-normal">
                    {t.name}
                  </TableCell>
                  <TableCell className="tabular-nums">{t.createdAt}</TableCell>
                  <TableCell className="tabular-nums">
                    {t.lastUsedAt ?? "未使用"}
                  </TableCell>
                  <TableCell>
                    {t.revokedAt ? (
                      <Badge variant="outline">失効（{t.revokedAt}）</Badge>
                    ) : (
                      "有効"
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {!t.revokedAt && <RevokeButton userId={userId} token={t} />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function RevokeButton({
  userId,
  token,
}: {
  userId: string;
  token: ApiTokenRow;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(undefined);
    startTransition(async () => {
      const result = await revokeApiTokenAction(userId, token.id);
      if (result.ok) {
        setOpen(false);
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
      <DialogTrigger render={<Button size="sm" variant="destructive" />}>
        失効
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>API トークンを失効させる</DialogTitle>
          <DialogDescription>
            トークン「{token.name}」を失効させます。失効したトークンでは API
            を使えなくなり、元に戻せません。
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
          <Button variant="destructive" onClick={submit} disabled={pending}>
            {pending ? "処理中…" : "失効させる"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
