import { NextRequest } from "next/server";

import {
  isHeatmapPeriodKey,
  isMarketKey,
  parseStockCodeList,
  streamQuoteData,
} from "@/lib/market-heatmap";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const marketParam = request.nextUrl.searchParams.get("market") ?? "all";
  const periodParam = request.nextUrl.searchParams.get("period") ?? "day";
  const codes = parseStockCodeList(request.nextUrl.searchParams.get("codes"));

  if (codes.length === 0 && !isMarketKey(marketParam)) {
    return Response.json(
      { success: false, message: `Invalid market: ${marketParam}` },
      { status: 400 }
    );
  }

  if (!isHeatmapPeriodKey(periodParam)) {
    return Response.json(
      { success: false, message: `Invalid period: ${periodParam}` },
      { status: 400 }
    );
  }

  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (value: unknown) => {
        if (!closed && !request.signal.aborted) {
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        }
      };

      void streamQuoteData({
        market: isMarketKey(marketParam) ? marketParam : "all",
        period: periodParam,
        codes: codes.length > 0 ? codes : undefined,
        signal: request.signal,
        emit: send,
      })
        .catch((error: unknown) => {
          send({
            type: "error",
            message: error instanceof Error ? error.message : "Failed to stream quote data",
          });
        })
        .finally(() => {
          if (!closed && !request.signal.aborted) {
            closed = true;
            controller.close();
          }
        });
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store, no-transform",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
