"use client";

import {
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatMoney } from "@/lib/format";

export interface ChartRow {
  label: string;
  earnings?: number | null;
  fcf?: number | null;
  earningsProjected?: number | null;
  fcfProjected?: number | null;
  projected: boolean;
}

// Series: categorical slots 1 & 2 of the reference palette, validated for both surfaces.
// Chrome (grid, axes, projection band): the zinc/slate terminal tokens from globals.css.
const PALETTE = {
  light: { earnings: "#2a78d6", fcf: "#eb6834", grid: "#e4e4e7", axis: "#64748b", band: "#f4f4f5", text: "#18181b" },
  dark: { earnings: "#3987e5", fcf: "#d95926", grid: "#27272a", axis: "#94a3b8", band: "#18181b", text: "#fafafa" },
};

// MacroPulse is dark-only, so charts always use the dark palette (the OS setting no longer applies).
const useDarkMode = () => true;

const compactMoney = (v: number, currency: string) => formatMoney(v, currency).replace(/\.\d+([TBM])$/, "$1");

export function SeriesKey({ dark }: { dark?: boolean }) {
  const c = dark ? PALETTE.dark : PALETTE.light;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-ink-3">
      {[
        { name: "Earnings (net income)", color: c.earnings },
        { name: "Free cash flow", color: c.fcf },
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
    <div className="rounded-md border border-line bg-panel px-3 py-2 text-xs shadow-sm">
      <div className="mb-1 font-semibold text-ink">
        {row.label} <span className="font-normal text-ink-3">{row.projected ? "· projected" : "· actual"}</span>
      </div>
      <div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 text-ink-2">
        <span>Earnings</span>
        <span className="text-right font-mono tabular-nums">{formatMoney(earnings, currency)}</span>
        <span>Free cash flow</span>
        <span className="text-right font-mono tabular-nums">{formatMoney(fcf, currency)}</span>
      </div>
    </div>
  );
}

export function ProjectionChart({ data, currency = "USD" }: { data: ChartRow[]; currency?: string }) {
  const c = useDarkMode() ? PALETTE.dark : PALETTE.light;
  const last = data[data.length - 1];
  const lastActual = [...data].reverse().find((d) => !d.projected)?.label;
  // End labels can sit on top of each other when the two series converge: put the
  // higher one above its point and the lower one below.
  const earningsOnTop = (last?.earningsProjected ?? 0) >= (last?.fcfProjected ?? 0);
  const endLabel = (key: "earningsProjected" | "fcfProjected", color: string) => (
    <LabelList
      dataKey={key}
      content={({ x, y, value, index }) =>
        index === data.length - 1 && typeof value === "number" ? (
          <text
            x={Number(x) + 8}
            y={Number(y)}
            dy={(key === "earningsProjected") === earningsOnTop ? -3 : 11}
            fontSize={11}
            fontWeight={600}
            fill={c.text}
          >
            <tspan fill={color}>● </tspan>
            {compactMoney(value, currency)}
          </text>
        ) : null
      }
    />
  );

  // Every line is static per render (no animation) so slider drags redraw instantly.
  const lineProps = { type: "monotone" as const, strokeWidth: 2, isAnimationActive: false, connectNulls: false };

  return (
    <ResponsiveContainer width="100%" height={340}>
      <LineChart data={data} margin={{ top: 16, right: 64, bottom: 4, left: 8 }}>
        {lastActual && last && <ReferenceArea x1={lastActual} x2={last.label} fill={c.band} fillOpacity={1} />}
        <CartesianGrid vertical={false} stroke={c.grid} />
        <XAxis dataKey="label" interval="preserveStartEnd" minTickGap={14} tick={{ fontSize: 10, fill: c.axis }} tickLine={false} axisLine={{ stroke: c.grid }} />
        <YAxis
          tickFormatter={(v: number) => compactMoney(v, currency)}
          tick={{ fontSize: 11, fill: c.axis }}
          tickLine={false}
          axisLine={false}
          width={56}
        />
        {lastActual && (
          <ReferenceLine
            x={lastActual}
            stroke={c.axis}
            strokeDasharray="2 3"
            label={{ value: "Projection →", position: "insideTopLeft", fontSize: 11, fill: c.axis }}
          />
        )}
        <Tooltip content={<ChartTooltip currency={currency} />} cursor={{ stroke: c.axis, strokeWidth: 1 }} />
        <Line {...lineProps} dataKey="earnings" name="Earnings" stroke={c.earnings} dot={{ r: 3, strokeWidth: 0, fill: c.earnings }} activeDot={{ r: 5 }} />
        <Line {...lineProps} dataKey="fcf" name="Free cash flow" stroke={c.fcf} dot={{ r: 3, strokeWidth: 0, fill: c.fcf }} activeDot={{ r: 5 }} />
        <Line
          {...lineProps}
          dataKey="earningsProjected"
          name="Earnings (projected)"
          stroke={c.earnings}
          strokeDasharray="6 4"
          dot={false}
          activeDot={{ r: 5 }}
        >
          {endLabel("earningsProjected", c.earnings)}
        </Line>
        <Line {...lineProps} dataKey="fcfProjected" name="FCF (projected)" stroke={c.fcf} strokeDasharray="6 4" dot={false} activeDot={{ r: 5 }}>
          {endLabel("fcfProjected", c.fcf)}
        </Line>
      </LineChart>
    </ResponsiveContainer>
  );
}

export { useDarkMode };
