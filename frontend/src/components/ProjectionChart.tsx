"use client";

import { useEffect, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatAccounting, formatMoney } from "@/lib/format";
import { DUR } from "@/lib/motion";

export interface ChartRow {
  label: string;
  earnings?: number | null;
  fcf?: number | null;
  earningsProjected?: number | null;
  fcfProjected?: number | null;
  projected: boolean;
}

// Theme tokens (CSS variables), so the chart follows the Daylight / Night ledger theme with no JS.
// Primary series spruce over a mint area; the second series in ink-2. Smooth monotone curves throughout.
const C = {
  earnings: "var(--spruce)",
  fcf: "var(--ink-2)",
  area: "var(--mint)",
  grid: "var(--line)",
  axis: "var(--ink-3)",
  band: "var(--subtle)",
  text: "var(--ink)",
  panel: "var(--panel)",
};

const compactMoney = (v: number, currency: string) => formatMoney(v, currency).replace(/\.\d+([TBM])$/, "$1");

export function SeriesKey() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-ink-3">
      {[
        { name: "Earnings (net income)", color: C.earnings },
        { name: "Free cash flow", color: C.fcf },
      ].map((s) => (
        <span key={s.name} className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded" style={{ background: s.color }} />
          {s.name}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <svg width="16" height="2" aria-hidden>
          <line x1="0" y1="1" x2="16" y2="1" stroke="currentColor" strokeWidth="2" strokeDasharray="4 3" />
        </svg>
        Projected
      </span>
    </div>
  );
}

function ChartTooltip({ active, payload, currency }: { active?: boolean; payload?: { payload: ChartRow }[]; currency: string }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const earnings = row.earnings ?? row.earningsProjected;
  const fcf = row.fcf ?? row.fcfProjected;
  return (
    <div className="rounded-md border border-line bg-panel px-3 py-2.5 text-[13px] shadow-2">
      <div className="mb-1 font-semibold text-ink">
        {row.label} <span className="font-normal text-ink-3">{row.projected ? "· projected" : "· actual"}</span>
      </div>
      <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 text-ink-2">
        <span>Earnings</span>
        <span className={`text-right font-semibold tabular-nums ${earnings != null && earnings < 0 ? "text-loss" : ""}`}>{formatAccounting(earnings, currency)}</span>
        <span>Free cash flow</span>
        <span className={`text-right font-semibold tabular-nums ${fcf != null && fcf < 0 ? "text-loss" : ""}`}>{formatAccounting(fcf, currency)}</span>
      </div>
    </div>
  );
}

export function ProjectionChart({ data, currency = "USD" }: { data: ChartRow[]; currency?: string }) {
  // Lines draw in once on first render; after that they redraw instantly so slider drags stay smooth.
  const [drawIn, setDrawIn] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setDrawIn(false), DUR[3] * 1000 + 100);
    return () => clearTimeout(t);
  }, []);

  const last = data[data.length - 1];
  const lastActualIdx = data.map((d) => !d.projected).lastIndexOf(true);
  const lastActual = lastActualIdx >= 0 ? data[lastActualIdx].label : undefined;
  // End labels can sit on top of each other when the two series converge: put the
  // higher one above its point and the lower one below.
  const earningsOnTop = (last?.earningsProjected ?? 0) >= (last?.fcfProjected ?? 0);
  const endLabel = (key: "earningsProjected" | "fcfProjected", color: string) => (
    <LabelList
      dataKey={key}
      content={({ x, y, value, index }) =>
        index === data.length - 1 && typeof value === "number" ? (
          <text x={Number(x) + 8} y={Number(y)} dy={(key === "earningsProjected") === earningsOnTop ? -3 : 12} fontSize={12} fontWeight={600} fill={C.text}>
            <tspan fill={color}>● </tspan>
            {compactMoney(value, currency)}
          </text>
        ) : null
      }
    />
  );
  // Only the last actual point gets a dot (spruce fill, panel ring).
  const lastDot = (color: string) =>
    function LastDot({ cx, cy, index }: { cx?: number; cy?: number; index?: number }) {
      return index === lastActualIdx && cx != null && cy != null ? (
        <circle key={`dot-${index}`} cx={cx} cy={cy} r={4.5} fill={color} stroke={C.panel} strokeWidth={2} />
      ) : (
        <g key={`dot-${index}`} />
      );
    };

  const lineProps = {
    type: "monotone" as const,
    strokeWidth: 2,
    connectNulls: false,
    isAnimationActive: drawIn,
    animationDuration: DUR[3] * 1000,
    animationEasing: "ease-out" as const,
  };

  return (
    <ResponsiveContainer width="100%" height={340}>
      <ComposedChart data={data} margin={{ top: 16, right: 64, bottom: 4, left: 8 }}>
        {lastActual && last && <ReferenceArea x1={lastActual} x2={last.label} fill={C.band} fillOpacity={1} />}
        <CartesianGrid vertical={false} stroke={C.grid} />
        <XAxis dataKey="label" interval="preserveStartEnd" minTickGap={14} tick={{ fontSize: 11, fill: C.axis }} tickLine={false} axisLine={{ stroke: C.grid }} />
        <YAxis tickFormatter={(v: number) => compactMoney(v, currency)} tick={{ fontSize: 11, fill: C.axis }} tickLine={false} axisLine={false} width={56} />
        {lastActual && (
          <ReferenceLine x={lastActual} stroke={C.axis} strokeDasharray="2 3" label={{ value: "Projection →", position: "insideTopLeft", fontSize: 12, fill: C.axis }} />
        )}
        <Tooltip content={<ChartTooltip currency={currency} />} cursor={{ stroke: C.axis, strokeWidth: 1 }} />
        <Area {...lineProps} dataKey="earnings" stroke="none" fill={C.area} fillOpacity={0.75} activeDot={false} />
        <Line {...lineProps} dataKey="earnings" name="Earnings" stroke={C.earnings} dot={lastDot(C.earnings)} activeDot={{ r: 5, stroke: C.panel, strokeWidth: 2 }} />
        <Line {...lineProps} dataKey="fcf" name="Free cash flow" stroke={C.fcf} dot={lastDot(C.fcf)} activeDot={{ r: 5, stroke: C.panel, strokeWidth: 2 }} />
        <Line {...lineProps} dataKey="earningsProjected" name="Earnings (projected)" stroke={C.earnings} strokeDasharray="6 4" dot={false} activeDot={{ r: 5 }}>
          {endLabel("earningsProjected", C.earnings)}
        </Line>
        <Line {...lineProps} dataKey="fcfProjected" name="FCF (projected)" stroke={C.fcf} strokeDasharray="6 4" dot={false} activeDot={{ r: 5 }}>
          {endLabel("fcfProjected", C.fcf)}
        </Line>
      </ComposedChart>
    </ResponsiveContainer>
  );
}
