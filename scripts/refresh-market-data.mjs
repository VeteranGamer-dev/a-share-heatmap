#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fallbackPath = path.join(repositoryRoot, "src/lib/data/market-heatmap-fallback.json");
const subboardsPath = path.join(repositoryRoot, "src/lib/data/market-heatmap-subboards.json");
const checkOnly = process.argv.includes("--check");

const hosts = [
  "push2delay.eastmoney.com",
  "82.push2.eastmoney.com",
  "7.push2.eastmoney.com",
  "48.push2.eastmoney.com",
  "push2.eastmoney.com",
];
const aShareFilter = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048";
const pageSize = 100;
const concurrency = 4;
const fields = ["f2", "f3", "f6", "f12", "f13", "f14", "f20", "f21", "f100", "f124"];
const requestHeaders = {
  Referer: "https://quote.eastmoney.com/",
  "User-Agent": "Mozilla/5.0 (compatible; AShareHeatmapDataRefresh/1.0)",
  Accept: "application/json, text/plain, */*",
};

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function finiteNumber(value, fallback = 0) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeCode(symbol, marketFlag) {
  const normalizedSymbol = String(symbol ?? "").trim();
  if (!/^\d{6}$/.test(normalizedSymbol)) {
    return null;
  }

  const exchange = Number(marketFlag) === 1 ? "SH" : /^[489]/.test(normalizedSymbol) ? "BJ" : "SZ";
  return `${normalizedSymbol}.${exchange}`;
}

function rowsFromPayload(payload) {
  return Array.isArray(payload?.data?.diff) ? payload.data.diff : [];
}

async function fetchPage(page) {
  let lastError;

  for (let attempt = 0; attempt < hosts.length; attempt += 1) {
    const params = new URLSearchParams({
      pn: String(page),
      pz: String(pageSize),
      po: "1",
      np: "1",
      ut: "bd1d9ddb04089700cf9c27f6f7426281",
      fltt: "2",
      invt: "2",
      fid: "f12",
      fs: aShareFilter,
      fields: fields.join(","),
    });

    try {
      const response = await fetch(`https://${hosts[attempt]}/api/qt/clist/get?${params}`, {
        headers: requestHeaders,
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      if (!Array.isArray(payload?.data?.diff)) {
        throw new Error("invalid payload");
      }
      return payload;
    } catch (error) {
      lastError = error;
      await sleep(200 * (attempt + 1) ** 2);
    }
  }

  throw new Error(`Unable to fetch Eastmoney page ${page}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

async function mapWithConcurrency(items, workerCount, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(workerCount, items.length) }, async () => {
      while (true) {
        const current = nextIndex;
        nextIndex += 1;
        if (current >= items.length) {
          return;
        }
        results[current] = await worker(items[current]);
      }
    })
  );

  return results;
}

function buildSectorLookup(subboards) {
  const lookup = new Map();
  for (const mapping of Object.values(subboards)) {
    const current = lookup.get(mapping.subBoardName);
    if (current && current !== mapping.sectorName) {
      throw new Error(`Secondary industry ${mapping.subBoardName} maps to multiple primary industries`);
    }
    lookup.set(mapping.subBoardName, mapping.sectorName);
  }
  return lookup;
}

function validateSnapshot(stocks, previousStocks, remoteTotal) {
  if (stocks.length < 5_000 || stocks.length < remoteTotal * 0.98) {
    throw new Error(`Stock snapshot is incomplete: parsed ${stocks.length} of ${remoteTotal}`);
  }

  if (stocks.length < previousStocks.length * 0.9) {
    throw new Error(`Stock count dropped unexpectedly: ${previousStocks.length} -> ${stocks.length}`);
  }

  const codes = new Set(stocks.map((stock) => stock.code));
  if (codes.size !== stocks.length) {
    throw new Error(`Stock codes are not unique: ${stocks.length - codes.size} duplicates`);
  }

  const removed = previousStocks.filter((stock) => !codes.has(stock.code));
  const maxRemoved = Math.max(100, Math.ceil(previousStocks.length * 0.03));
  if (removed.length > maxRemoved) {
    throw new Error(`Too many stocks disappeared: ${removed.length} > ${maxRemoved}`);
  }

  const totalCapCoverage = stocks.filter((stock) => stock.totalMarketCap > 0).length / stocks.length;
  const floatCapCoverage = stocks.filter((stock) => stock.floatMarketCap > 0).length / stocks.length;
  if (totalCapCoverage < 0.9 || floatCapCoverage < 0.9) {
    throw new Error(
      `Market-cap coverage is too low: total=${(totalCapCoverage * 100).toFixed(2)}%, float=${(floatCapCoverage * 100).toFixed(2)}%`
    );
  }
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
}

async function main() {
  const [fallbackRaw, subboardsRaw] = await Promise.all([
    fs.readFile(fallbackPath, "utf8"),
    fs.readFile(subboardsPath, "utf8"),
  ]);
  const previousFallback = JSON.parse(fallbackRaw);
  const previousSubboards = JSON.parse(subboardsRaw);
  const previousStocksByCode = new Map(previousFallback.stocks.map((stock) => [stock.code, stock]));
  const sectorBySubBoard = buildSectorLookup(previousSubboards.subboards);

  const firstPayload = await fetchPage(1);
  const remoteTotal = finiteNumber(firstPayload?.data?.total);
  if (remoteTotal <= 0) {
    throw new Error("Eastmoney returned an invalid stock count");
  }

  const pageCount = Math.ceil(remoteTotal / pageSize);
  const remainingPages = Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => index + 2);
  const payloads = [
    firstPayload,
    ...(await mapWithConcurrency(remainingPages, concurrency, (page) => fetchPage(page))),
  ];
  const rows = payloads.flatMap(rowsFromPayload);
  const unknownSubBoards = new Set();
  const stocksByCode = new Map();
  const mappingsByCode = new Map();

  for (const row of rows) {
    const code = normalizeCode(row.f12, row.f13);
    const name = String(row.f14 ?? "").trim();
    if (!code || !name) {
      continue;
    }

    const previousStock = previousStocksByCode.get(code);
    const previousMapping = previousSubboards.subboards[code];
    const remoteSubBoardName = String(row.f100 ?? "").trim().replace(/Ⅱ$/, "");
    const subBoardName =
      (remoteSubBoardName && remoteSubBoardName !== "-" ? remoteSubBoardName : "") ||
      previousMapping?.subBoardName ||
      previousStock?.boardName ||
      "其他";
    const sectorName = sectorBySubBoard.get(subBoardName) ?? previousMapping?.sectorName ?? "其他";
    if (sectorName === "其他" && subBoardName !== "其他") {
      unknownSubBoards.add(subBoardName);
    }

    const totalMarketCap = finiteNumber(row.f20, previousStock?.totalMarketCap ?? 0);
    const floatMarketCap = finiteNumber(row.f21, previousStock?.floatMarketCap ?? totalMarketCap);
    const stock = {
      code,
      exchange: code.endsWith(".SH") ? "SH" : code.endsWith(".BJ") ? "BJ" : "SZ",
      name,
      boardName: sectorName,
      price: finiteNumber(row.f2, previousStock?.price ?? 0),
      changePct: finiteNumber(row.f3, 0),
      totalMarketCap,
      floatMarketCap,
    };

    stocksByCode.set(code, stock);
    mappingsByCode.set(code, { sectorName, subBoardName });
  }

  const stocks = Array.from(stocksByCode.values()).sort((left, right) => {
    const boardOrder = left.boardName.localeCompare(right.boardName, "zh-CN");
    if (boardOrder !== 0) return boardOrder;
    const capOrder = right.floatMarketCap - left.floatMarketCap;
    return capOrder !== 0 ? capOrder : left.code.localeCompare(right.code);
  });
  validateSnapshot(stocks, previousFallback.stocks, remoteTotal);

  const latestQuoteTimestamp = rows.reduce((latest, row) => Math.max(latest, finiteNumber(row.f124)), 0);
  const updatedAt = latestQuoteTimestamp > 0
    ? new Date(latestQuoteTimestamp * 1_000).toISOString()
    : new Date().toISOString();
  const fallbackSnapshot = {
    updatedAt,
    stockCount: stocks.length,
    boardCount: new Set(stocks.map((stock) => stock.boardName)).size,
    stocks,
  };
  const sortedMappings = Object.fromEntries(
    Array.from(mappingsByCode.entries()).sort(([left], [right]) => left.localeCompare(right))
  );
  const subboardSnapshot = {
    updatedAt,
    count: stocks.length,
    subboards: sortedMappings,
  };

  const previousCodes = new Set(previousFallback.stocks.map((stock) => stock.code));
  const added = stocks.filter((stock) => !previousCodes.has(stock.code));
  const removed = previousFallback.stocks.filter((stock) => !stocksByCode.has(stock.code));

  if (!checkOnly) {
    await Promise.all([
      writeJsonAtomically(fallbackPath, fallbackSnapshot),
      writeJsonAtomically(subboardsPath, subboardSnapshot),
    ]);
  }

  console.log(
    `${checkOnly ? "Validated" : "Updated"} ${stocks.length} stocks across ${fallbackSnapshot.boardCount} primary industries; added ${added.length}, removed ${removed.length}.`
  );
  if (unknownSubBoards.size > 0) {
    console.warn(`Unmapped secondary industries were placed in 其他: ${Array.from(unknownSubBoards).sort().join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
