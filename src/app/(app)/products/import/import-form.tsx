"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
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

import { importProductsAction, type ImportProductsState } from "../actions";

const INITIAL_STATE: ImportProductsState = { status: "idle" };

/** CSV 取込のフォームと結果（成功の件数、またはエラーの一覧） */
export function ImportForm() {
  const [state, formAction, pending] = useActionState(
    importProductsAction,
    INITIAL_STATE,
  );

  return (
    <div className="space-y-4">
      <form
        action={formAction}
        className="flex max-w-2xl flex-wrap items-end gap-2"
      >
        <div className="grid w-full gap-1.5 sm:w-auto sm:min-w-80">
          <Label htmlFor="file">CSV ファイル</Label>
          <Input
            id="file"
            name="file"
            type="file"
            accept=".csv,text/csv"
            required
          />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "取込中…" : "取り込む"}
        </Button>
      </form>

      {state.status === "success" && (
        <div
          role="status"
          className="max-w-2xl space-y-2 rounded-lg border border-emerald-600/30 bg-emerald-600/5 p-3 text-sm"
        >
          <p className="font-medium">
            {state.fileName} を取り込みました: 新規 {state.summary.created}{" "}
            件・更新 {state.summary.updated} 件・変更なし{" "}
            {state.summary.unchanged} 件
          </p>
          <Link
            href="/products"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            商品一覧へ
          </Link>
        </div>
      )}

      {state.status === "error" && (
        <div role="alert" className="space-y-3">
          <p className="max-w-2xl rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {state.fileName && (
              <span className="font-medium">{state.fileName}: </span>
            )}
            {state.message}
          </p>
          {state.errors.length > 0 && (
            <div className="max-w-3xl space-y-2">
              <p className="text-sm">
                エラー {state.totalErrors.toLocaleString("ja-JP")} 件
                {state.totalErrors > state.errors.length &&
                  `（先頭の ${state.errors.length} 件を表示）`}
              </p>
              <div className="rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-20 text-right">行</TableHead>
                      <TableHead className="w-28">項目</TableHead>
                      <TableHead>内容</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {state.errors.map((error, index) => (
                      <TableRow key={index}>
                        <TableCell className="text-right tabular-nums">
                          {error.line === null ? "—" : `${error.line} 行目`}
                        </TableCell>
                        <TableCell>{error.field ?? "—"}</TableCell>
                        <TableCell className="whitespace-normal">
                          {error.message}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
