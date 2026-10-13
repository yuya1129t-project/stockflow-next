import { Badge } from "@/components/ui/badge";
import {
  SALES_ORDER_STATUS_LABELS,
  type SalesOrderStatus,
} from "@/lib/sales-orders/status";

const VARIANTS = {
  draft: "outline",
  confirmed: "default",
  shipped: "secondary",
  cancelled: "destructive",
} as const satisfies Record<SalesOrderStatus, string>;

/** 受注のステータスの表示 */
export function SalesOrderStatusBadge({
  status,
}: {
  status: SalesOrderStatus;
}) {
  return (
    <Badge variant={VARIANTS[status]}>
      {SALES_ORDER_STATUS_LABELS[status]}
    </Badge>
  );
}
