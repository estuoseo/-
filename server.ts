/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";

const app = express();
const PORT = 3000;

// Standardized list of 14 return bins specified by the user
const RETURN_BINS = [
  "중앙도서관",
  "교육관",
  "현차관",
  "엘포관",
  "백기",
  "싱싱주스",
  "대학원 도서관",
  "노열",
  "교양관",
  "국제관",
  "서관",
  "미래관 3층",
  "학생회관",
  "더베이크"
];

// Area A bins mapping for waste sheet (in visual order represented in columns)
const ZONE_A_BINS = [
  "중앙도서관",
  "교육관",
  "현차관",
  "엘포관",
  "백기",
  "싱싱주스",
  "노열"
];

// Area B bins mapping for waste sheet (in visual order represented in columns)
const ZONE_B_BINS = [
  "교양관",
  "국제관",
  "서관",
  "미래관 3층",
  "미래관 B1층", // We map and track B1 but it is processed as an extra or filtered out to match exactly 14 bins
  "더베이크"
];

// In-Memory cache for parsed dashboard data
let cachedResponse: any = null;
let lastFetchTime = 0;
const CACHE_TTL = 3 * 60 * 1000; // 3 minutes cache lifespan

// Safe date parsing helper
function parseGvizDate(cell: any): string | null {
  if (!cell) return null;
  const val = cell.v;
  if (!val) {
    if (cell.f) return parseFormattedDate(cell.f);
    return null;
  }
  if (typeof val === 'string' && val.startsWith('Date(')) {
    const match = val.match(/Date\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      const year = parseInt(match[1]);
      const month = parseInt(match[2]) + 1; // Month index in Date(Y, M, D) is 0-indexed
      return `${year}.${String(month).padStart(2, '0')}`;
    }
  }
  if (typeof val === 'string') {
    return parseFormattedDate(val);
  }
  if (cell.f) {
    return parseFormattedDate(cell.f);
  }
  return null;
}

function parseFormattedDate(fStr: string): string | null {
  const clean = fStr.replace(/\s+/g, '');
  const match = clean.match(/^(\d{4})[./-](\d{1,2})/);
  if (match) {
    const year = match[1];
    const month = String(parseInt(match[2])).padStart(2, '0');
    return `${year}.${month}`;
  }
  return null;
}

// Helper utilities for dynamic bin mapping by month
function isBeforeOrEqualMonth(m1: string, m2: string): boolean {
  const [y1, mo1] = m1.split('.').map(Number);
  const [y2, mo2] = m2.split('.').map(Number);
  if (y1 !== y2) return y1 < y2;
  return mo1 <= mo2;
}

function getReturnBinsForMonth(month: string): string[] {
  const bins = [...RETURN_BINS];
  if (isBeforeOrEqualMonth(month, "2026.02")) {
    bins[12] = "미래관 B1층";
  }
  return bins;
}

function getTrashBinName(rawBinName: string, month: string): string {
  if (rawBinName === "미래관 B1층") {
    if (isBeforeOrEqualMonth(month, "2026.02")) {
      return "미래관 B1층";
    } else {
      return "학생회관";
    }
  }
  return rawBinName;
}

// Fetch and parse helper
async function fetchSheetJson(sheetName: string): Promise<any> {
  const sheetId = "1UXBIw5w_X9jzl70tFpNYvJd9FYiArT1wHCibJg4Kk6I";
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?sheet=${encodeURIComponent(sheetName)}&tq=select%20*`;
  
  const res = await fetch(url);
  const text = await res.text();
  
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd !== -1) {
    const jsonStr = text.substring(jsonStart, jsonEnd + 1);
    return JSON.parse(jsonStr);
  }
  throw new Error(`Failed to extract JSON for sheet: ${sheetName}`);
}

async function getDashboardData() {
  const now = Date.now();
  if (cachedResponse && (now - lastFetchTime < CACHE_TTL)) {
    return cachedResponse;
  }

  try {
    // 1. Fetch all 4 sheets concurrently
    const [returnsRaw, trashARaw, trashBRaw, cwRaw] = await Promise.all([
      fetchSheetJson("다회용컵 반납량"),
      fetchSheetJson("A구역 쓰레기"),
      fetchSheetJson("B구역 쓰레기"),
      fetchSheetJson("반납함 별 컵 반납량, 쓰레기량, 오염률, C/W").catch(err => {
        console.warn("Failed to fetch C/W sheet, using fallback:", err.message);
        return null;
      })
    ]);

    // Data maps to populate
    const monthsSet = new Set<string>();
    
    // Month -> { binName: returnsCount }
    const returnsByMonthBin: Record<string, Record<string, number>> = {};
    
    // Month -> Bin -> { general, disposable, reusable }
    const trashByMonthBin: Record<string, Record<string, { general: number; disposable: number; reusable: number; total: number }>> = {};

    // First process Returns sheet
    const returnsRows = returnsRaw.table.rows;
    for (const row of returnsRows) {
      if (!row || !row.c || !row.c[0]) continue;
      
      const dateKey = parseGvizDate(row.c[0]);
      if (!dateKey) continue;
      
      monthsSet.add(dateKey);
      
      const binsForMonth = getReturnBinsForMonth(dateKey);
      if (!returnsByMonthBin[dateKey]) {
        returnsByMonthBin[dateKey] = {};
        // Initialize 14 bins
        binsForMonth.forEach(b => {
          returnsByMonthBin[dateKey][b] = 0;
        });
      }

      // Loop over index 1 through 14 (cols mapping to the 14 return bins)
      for (let i = 0; i < binsForMonth.length; i++) {
        const binName = binsForMonth[i];
        const cell = row.c[i + 1];
        if (cell && cell.v !== null) {
          const val = typeof cell.v === 'number' ? cell.v : parseInt(String(cell.v)) || 0;
          returnsByMonthBin[dateKey][binName] += val;
        }
      }
    }

    // Process Area A trash
    const trashARows = trashARaw.table.rows;
    for (const row of trashARows) {
      if (!row || !row.c || !row.c[1]) continue;
      
      const dateKey = parseGvizDate(row.c[1]);
      if (!dateKey) continue;
      
      monthsSet.add(dateKey);

      if (!trashByMonthBin[dateKey]) {
        trashByMonthBin[dateKey] = {};
      }

      // Process 7 bins of Zone A
      for (let i = 0; i < ZONE_A_BINS.length; i++) {
        const binName = ZONE_A_BINS[i];
        const baseIndex = 2 + i * 4;
        
        const cellGen = row.c[baseIndex];
        const cellDisp = row.c[baseIndex + 1];
        const cellReu = row.c[baseIndex + 2];
        const cellTotal = row.c[baseIndex + 3];

        const general = cellGen && cellGen.v !== null ? (typeof cellGen.v === 'number' ? cellGen.v : parseInt(String(cellGen.v)) || 0) : 0;
        const disposable = cellDisp && cellDisp.v !== null ? (typeof cellDisp.v === 'number' ? cellDisp.v : parseInt(String(cellDisp.v)) || 0) : 0;
        const reusable = cellReu && cellReu.v !== null ? (typeof cellReu.v === 'number' ? cellReu.v : parseInt(String(cellReu.v)) || 0) : 0;
        const total = cellTotal && cellTotal.v !== null ? (typeof cellTotal.v === 'number' ? cellTotal.v : parseInt(String(cellTotal.v)) || 0) : (general + disposable + reusable);

        if (!trashByMonthBin[dateKey][binName]) {
          trashByMonthBin[dateKey][binName] = { general: 0, disposable: 0, reusable: 0, total: 0 };
        }
        
        trashByMonthBin[dateKey][binName].general += general;
        trashByMonthBin[dateKey][binName].disposable += disposable;
        trashByMonthBin[dateKey][binName].reusable += reusable;
        trashByMonthBin[dateKey][binName].total += total;
      }
    }

    // Process Area B trash
    const trashBRows = trashBRaw.table.rows;
    for (const row of trashBRows) {
      if (!row || !row.c || !row.c[1]) continue;
      
      const dateKey = parseGvizDate(row.c[1]);
      if (!dateKey) continue;
      
      monthsSet.add(dateKey);

      if (!trashByMonthBin[dateKey]) {
        trashByMonthBin[dateKey] = {};
      }

      // Process 6 bins of Zone B
      for (let i = 0; i < ZONE_B_BINS.length; i++) {
        const rawBinName = ZONE_B_BINS[i];
        const binName = getTrashBinName(rawBinName, dateKey);
        
        const baseIndex = 2 + i * 4;
        
        const cellGen = row.c[baseIndex];
        const cellDisp = row.c[baseIndex + 1];
        const cellReu = row.c[baseIndex + 2];
        const cellTotal = row.c[baseIndex + 3];

        const general = cellGen && cellGen.v !== null ? (typeof cellGen.v === 'number' ? cellGen.v : parseInt(String(cellGen.v)) || 0) : 0;
        const disposable = cellDisp && cellDisp.v !== null ? (typeof cellDisp.v === 'number' ? cellDisp.v : parseInt(String(cellDisp.v)) || 0) : 0;
        const reusable = cellReu && cellReu.v !== null ? (typeof cellReu.v === 'number' ? cellReu.v : parseInt(String(cellReu.v)) || 0) : 0;
        const total = cellTotal && cellTotal.v !== null ? (typeof cellTotal.v === 'number' ? cellTotal.v : parseInt(String(cellTotal.v)) || 0) : (general + disposable + reusable);

        if (!trashByMonthBin[dateKey][binName]) {
          trashByMonthBin[dateKey][binName] = { general: 0, disposable: 0, reusable: 0, total: 0 };
        }
        
        trashByMonthBin[dateKey][binName].general += general;
        trashByMonthBin[dateKey][binName].disposable += disposable;
        trashByMonthBin[dateKey][binName].reusable += reusable;
        trashByMonthBin[dateKey][binName].total += total;
      }
    }

    const months = Array.from(monthsSet).sort();
    const latestMonth = months[months.length - 1] || "";

    // Build monthly return trends
    const monthlyTrends = months.map(m => {
      const binReturns = returnsByMonthBin[m] || {};
      const totalReturns = Object.values(binReturns).reduce((sum, count) => sum + count, 0);
      return { date: m, totalReturns };
    });

    // Populate missing returns or trash entries with zeroes for consistent results
    months.forEach(m => {
      const binsForMonth = getReturnBinsForMonth(m);
      if (!returnsByMonthBin[m]) {
        returnsByMonthBin[m] = {};
        binsForMonth.forEach(b => {
          returnsByMonthBin[m][b] = 0;
        });
      }
      if (!trashByMonthBin[m]) {
        trashByMonthBin[m] = {};
      }
      binsForMonth.forEach(b => {
        if (!trashByMonthBin[m][b]) {
          trashByMonthBin[m][b] = { general: 0, disposable: 0, reusable: 0, total: 0 };
        }
      });
    });

    // 1. Initialise C/W Pollution Data dictionary if sheet was successfully loaded
    const cwPollutionData: Record<string, any[]> = {};
    if (cwRaw && cwRaw.table && cwRaw.table.rows) {
      let currentCwMonth = "2025.09"; // default
      const col2Label = cwRaw.table.cols[2]?.label || "";
      const colMatch = col2Label.match(/(\d+)월/);
      if (colMatch) {
        const monthNum = String(colMatch[1]).padStart(2, '0');
        const matchedMonth = Array.from(monthsSet).find(m => m.endsWith(`.${monthNum}`));
        currentCwMonth = matchedMonth || `2025.${monthNum}`;
      }

      for (const row of cwRaw.table.rows) {
        if (!row || !row.c) continue;

        const cell2Val = row.c[2]?.v;
        if (cell2Val && typeof cell2Val === 'string' && cell2Val.includes("월")) {
          const mMatch = cell2Val.match(/(\d+)월/);
          if (mMatch) {
            const monthNum = String(mMatch[1]).padStart(2, '0');
            const matchedMonth = Array.from(monthsSet).find(m => m.endsWith(`.${monthNum}`));
            currentCwMonth = matchedMonth || `2025.${monthNum}`;
            continue;
          }
        }

        const binCell = row.c[3];
        if (!binCell || !binCell.v) continue;
        const rawBinName = String(binCell.v).trim();
        
        const binsForMonth = getReturnBinsForMonth(currentCwMonth);
        const matchedBinName = binsForMonth.find(b => rawBinName.includes(b)) || 
          (rawBinName === "미래관 B1층" ? (binsForMonth.includes("미래관 B1층") ? "미래관 B1층" : "학생회관") : null);
        
        if (!matchedBinName) continue;

        const cups = row.c[4] && row.c[4].v !== null ? Number(row.c[4].v) : 0;
        const waste = row.c[5] && row.c[5].v !== null ? Number(row.c[5].v) : 0;
        const rateVal = row.c[6] && row.c[6].v !== null ? Number(row.c[6].v) : 0;
        const ratePct = parseFloat((rateVal * 100).toFixed(2)); // Multiply by 100 to get percentage scale
        const wcRatioVal = row.c[7] && row.c[7].v !== null ? Number(row.c[7].v) : (cups > 0 ? parseFloat((waste / cups).toFixed(2)) : 0);

        if (!cwPollutionData[currentCwMonth]) {
          cwPollutionData[currentCwMonth] = [];
        }

        cwPollutionData[currentCwMonth].push({
          binName: matchedBinName,
          generalTrash: waste,
          disposableCups: 0,
          reusableCups: cups,
          totalTrash: cups + waste,
          contaminationRate: ratePct,
          wcRatio: wcRatioVal
        });
      }
    }

    // Compute monthly and overall pollution maps
    const monthlyPollution: Record<string, any[]> = {};
    const overallPollutionTotals: Record<string, { general: number; disposable: number; reusable: number; total: number }> = {};

    months.forEach(m => {
      const binsForMonth = getReturnBinsForMonth(m);
      
      binsForMonth.forEach(b => {
        if (!overallPollutionTotals[b]) {
          overallPollutionTotals[b] = { general: 0, disposable: 0, reusable: 0, total: 0 };
        }
      });

      // Check if C/W sheet has records for this month
      if (cwPollutionData[m] && cwPollutionData[m].length > 0) {
        monthlyPollution[m] = cwPollutionData[m];
        
        // Sum overall based on this month's values
        cwPollutionData[m].forEach(item => {
          const b = item.binName;
          if (!overallPollutionTotals[b]) {
            overallPollutionTotals[b] = { general: 0, disposable: 0, reusable: 0, total: 0 };
          }
          overallPollutionTotals[b].general += item.generalTrash;
          overallPollutionTotals[b].reusable += item.reusableCups;
          overallPollutionTotals[b].total += item.totalTrash;
        });
      } else {
        // Fallback to Area A/B trash calculation
        const pList: any[] = [];
        binsForMonth.forEach(b => {
          const trash = trashByMonthBin[m][b] || { general: 0, disposable: 0, reusable: 0, total: 0 };
          
          // Sum overall
          overallPollutionTotals[b].general += trash.general;
          overallPollutionTotals[b].disposable += trash.disposable;
          overallPollutionTotals[b].reusable += trash.reusable;
          overallPollutionTotals[b].total += trash.total;

          // Count rate (percentage scale)
          const rate = trash.total > 0 ? ((trash.general + trash.disposable) / trash.total) * 100 : 0;
          
          pList.push({
            binName: b,
            generalTrash: trash.general,
            disposableCups: trash.disposable,
            reusableCups: trash.reusable,
            totalTrash: trash.total,
            contaminationRate: parseFloat(rate.toFixed(2)),
            wcRatio: trash.reusable > 0 ? parseFloat((trash.general / trash.reusable).toFixed(2)) : 0
          });
        });
        monthlyPollution[m] = pList;
      }
    });

    // Form overall details
    const allEverBins = Array.from(new Set(months.flatMap(m => getReturnBinsForMonth(m))));
    const overallPollution = allEverBins.map(b => {
      const trash = overallPollutionTotals[b] || { general: 0, disposable: 0, reusable: 0, total: 0 };
      const rate = trash.total > 0 ? ((trash.general + trash.disposable) / trash.total) * 100 : 0;
      return {
        binName: b,
        generalTrash: trash.general,
        disposableCups: trash.disposable,
        reusableCups: trash.reusable,
        totalTrash: trash.total,
        contaminationRate: parseFloat(rate.toFixed(2)),
        wcRatio: trash.reusable > 0 ? parseFloat((trash.general / trash.reusable).toFixed(2)) : 0
      };
    });

    cachedResponse = {
      months,
      latestMonth,
      monthlyTrends,
      monthlyBinReturns: returnsByMonthBin,
      monthlyPollution,
      overallPollution,
      lastUpdated: new Date().toISOString()
    };
    
    lastFetchTime = now;
    return cachedResponse;
  } catch (error: any) {
    console.error("Error aggregating dashboard data:", error);
    throw error;
  }
}

// 2. Setup standard API end points
app.get("/api/cups-data", async (req, res) => {
  try {
    const data = await getDashboardData();
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch spreadsheet data", details: error.message });
  }
});

// Create helper endpoint to force refresh the cache
app.post("/api/cups-data/refresh", async (req, res) => {
  try {
    lastFetchTime = 0; // Invalidate cache
    const data = await getDashboardData();
    res.json({ success: true, message: "Cache refreshed", data });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to refresh cache", details: error.message });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Vite middleware setup
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
