import { Prisma, SourceKind } from "@prisma/client";

/** The common current-version transition for CSV and API Cafe24 writes. */
export async function persistCafe24CanonicalLine(tx: Prisma.TransactionClient, input: {
  source: SourceKind;
  connectionId: string | null;
  orderLineKey: string;
  previousCurrentIds: string[];
  data: Prisma.Cafe24OrderLineCreateManyInput;
}) {
  const previous = input.data.isCurrent ? input.previousCurrentIds : [];
  const scope = {
    id: { in: previous }, source: input.source,
    connectionId: input.connectionId, orderLineKey: input.orderLineKey,
    isCurrent: true
  };
  if (previous.length) await tx.cafe24OrderLine.updateMany({ where: scope, data: { isCurrent: false } });
  const line = await tx.cafe24OrderLine.create({ data: input.data });
  if (previous.length) await tx.cafe24OrderLine.updateMany({
    where: { id: { in: previous }, source: input.source,
      connectionId: input.connectionId, orderLineKey: input.orderLineKey },
    data: { supersededByOrderLineId: line.id }
  });
  return line;
}
