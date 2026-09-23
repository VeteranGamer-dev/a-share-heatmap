import snapshot from "@/lib/data/market-heatmap-fallback.json";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

const headers = {
  Referer: "https://gu.qq.com/",
  "User-Agent": "Mozilla/5.0 (compatible; AShareHeatmap/1.0)",
  Accept: "*/*",
};

async function probe(symbols: string[]) {
  const started = Date.now();
  try {
    const response = await fetch(`https://qt.gtimg.cn/q=${symbols.join(",")}`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    const body = new TextDecoder("gbk").decode(await response.arrayBuffer());
    const rows = [...body.matchAll(/v_((?:sh|sz|bj)\d{6})="([^"]*)";/g)];
    return {
      status: response.status,
      milliseconds: Date.now() - started,
      bytes: body.length,
      rows: rows.length,
      periodFields: rows.filter((row) => {
        const fields = row[2].split("~");
        return fields.length > 70 && [62, 63, 70].every((index) => fields[index]?.trim());
      }).length,
      firstFieldCount: rows[0]?.[2].split("~").length ?? 0,
      firstFieldValues: rows[0]
        ? [62, 63, 70].map((index) => rows[0][2].split("~")[index] ?? "")
        : [],
      prefix: body.slice(0, 60),
    };
  } catch (error) {
    return { milliseconds: Date.now() - started, error: String(error) };
  }
}

export default async function SourceProbePage() {
  const symbols = snapshot.stocks.slice(0, 300).map((stock) =>
    `${stock.exchange.toLowerCase()}${stock.code.slice(0, 6)}`
  );
  const [one, batch] = await Promise.all([probe(symbols.slice(0, 1)), probe(symbols)]);
  return <pre>{JSON.stringify({ now: new Date().toISOString(), one, batch }, null, 2)}</pre>;
}
