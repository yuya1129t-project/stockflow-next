"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

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

import { setPartnerActiveAction } from "../actions";

/** 無効化・再有効化のボタンと確認ダイアログ（admin のみ表示。権限はサーバー側でも検査する） */
export function PartnerActiveToggle({
  id,
  code,
  name,
  isActive,
}: {
  id: number;
  code: string;
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
      const result = await setPartnerActiveAction(id, next);
      if (result.ok) {
        setOpen(false);
        // 「保存しました」などの前の操作の表示を消す
        router.replace(`/partners/${id}`);
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
          <DialogTitle>取引先を{verb}</DialogTitle>
          <DialogDescription>
            {code}「{name}」を{next ? "再度有効にします" : "無効にします"}。
            {next
              ? "新規の受注・発注で再び選べるようになります。"
              : "無効にした取引先は新規の受注・発注で選べなくなります。取引先のデータと受注・発注の履歴は残り、あとで再度有効にできます。"}
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
