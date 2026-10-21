"use client";

import React, { useState } from "react";

import { calculateMultiPeriodDcf } from "../services/financialMath";
import { BusinessProfile, BusinessType, routeBusinessToModel } from "../utils/financialRouter";

interface Props {
  initialBusinessProfile: BusinessProfile;
}

export const FinancialModelCard: React.FC<Props> = ({ initialBusinessProfile }) => {
  const [profile, setProfile] = useState<BusinessProfile>(initialBusinessProfile);
  const [discountRate, setDiscountRate] = useState<number>(0.1);
  const [terminalGrowth, setTerminalGrowth] = useState<number>(0.025);
  const [growthRates] = useState<number[]>([0.25, 0.2, 0.15, 0.1, 0.05]);

  const routerConfig = routeBusinessToModel(profile);
  const baseCashFlowForCalculation = profile.type === BusinessType.SAAS ? (profile.metrics.mrr || 0) * 12 * 0.25 : profile.metrics.ebitda * 0.8;
  const valuation = calculateMultiPeriodDcf({
    baseCashFlow: baseCashFlowForCalculation,
    growthRates,
    discountRate,
    terminalGrowthRate: terminalGrowth,
    netDebt: profile.metrics.debt - profile.metrics.cash,
  });

  // Required inputs that are business metrics but weren't supplied (e.g. a SaaS profile without MRR
  // would otherwise value at $0 with no explanation).
  const missingInputs = routerConfig.requiredInputs.filter(
    (key) => key in emptyMetrics && profile.metrics[key as keyof BusinessProfile["metrics"]] == null,
  );
  const warnings = [...(missingInputs.length ? [`Missing required inputs for this model: ${missingInputs.join(", ")}.`] : []), ...valuation.warnings];

  return (
    <div className="panel max-w-[600px] p-6 font-sans">
      <h2 className="text-lg font-semibold tracking-tight text-ink">Valuation Workspace: {profile.name}</h2>
      <div className="mt-3 mb-4 rounded bg-subtle p-3 text-[13px] text-ink">
        <strong>Assigned Engine:</strong> {routerConfig.recommendedModel}
        <p className="mt-1 text-[13px] text-ink-3">{routerConfig.justification}</p>
      </div>
      <div className="mb-5">
        <h3 className="mb-3 text-[14px] font-medium text-ink">Core Model Assumptions</h3>
        {profile.type === BusinessType.SAAS && (
          <div className="mb-3 text-[13px] text-ink-2">
            <label htmlFor="fmc-churn">Annual Churn Sensitivity Constraint: </label>
            <input
              id="fmc-churn"
              type="range"
              min="0.02"
              max="0.30"
              step="0.01"
              value={profile.metrics.churnRate || 0.1}
              onChange={(e) => setProfile({ ...profile, metrics: { ...profile.metrics, churnRate: parseFloat(e.target.value) } })}
              className="align-middle accent-spruce dark:accent-spruce"
            />
            <span> {((profile.metrics.churnRate || 0.1) * 100).toFixed(0)}% Churn Rate</span>
          </div>
        )}
        <div className="mb-3 text-[13px] text-ink-2">
          <label htmlFor="fmc-discount">Discount Rate (WACC Baseline): </label>
          <input
            id="fmc-discount"
            type="range"
            min="0.06"
            max="0.20"
            step="0.005"
            value={discountRate}
            onChange={(e) => setDiscountRate(parseFloat(e.target.value))}
            className="align-middle accent-spruce dark:accent-spruce"
          />
          <span> {(discountRate * 100).toFixed(1)}%</span>
        </div>
        <div className="mb-3 text-[13px] text-ink-2">
          <label htmlFor="fmc-terminal">Terminal Growth Rate Factor: </label>
          <input
            id="fmc-terminal"
            type="range"
            min="0.01"
            max="0.05"
            step="0.001"
            value={terminalGrowth}
            onChange={(e) => setTerminalGrowth(parseFloat(e.target.value))}
            className="align-middle accent-spruce dark:accent-spruce"
          />
          <span> {(terminalGrowth * 100).toFixed(1)}%</span>
        </div>
      </div>
      <div className="border-t-2 border-line pt-4">
        <h3 className="mb-3 text-[14px] font-medium text-ink">Calculated Intrinsic Valuation Summary</h3>
        <div className="mb-2 flex justify-between text-[13px] text-ink-2">
          <span>Enterprise Value:</span>
          <strong className="font-mono text-ink tabular-nums">
            ${valuation.enterpriseValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </strong>
        </div>
        <div className="mb-2 flex justify-between text-[13px] text-ink-2">
          <span>Equity Value:</span>
          <strong className="font-mono text-ink tabular-nums">${valuation.equityValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
        </div>
        {warnings.length > 0 && (
          <div
            role="status"
            className="mt-4 rounded bg-caution-bg p-3 text-[13px] text-caution ring-1 ring-caution/30 ring-inset dark:bg-caution-bg dark:text-caution dark:ring-caution"
          >
            <strong>Valuation Framework Warnings:</strong>
            <ul className="mt-1 list-disc pl-5">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
};

// Keys of BusinessProfile["metrics"], to tell metric inputs apart from model parameters (discountRate…).
const emptyMetrics: Record<keyof BusinessProfile["metrics"], true> = {
  revenue: true,
  ebitda: true,
  cash: true,
  debt: true,
  mrr: true,
  churnRate: true,
  gmv: true,
  takeRate: true,
  netAssetValue: true,
  capEx: true,
};
