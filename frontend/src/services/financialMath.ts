export interface DcfInputs {
  baseCashFlow: number;
  growthRates: number[];
  discountRate: number;
  terminalGrowthRate: number;
  netDebt: number;
}

export interface ValuationOutput {
  enterpriseValue: number;
  equityValue: number;
  terminalValueContributionPercentage: number;
  warnings: string[];
}

export const TERMINAL_GROWTH_CAP = 0.03;
export const TERMINAL_SHARE_WARNING_PCT = 75;

export function calculateMultiPeriodDcf(inputs: DcfInputs): ValuationOutput {
  const warnings: string[] = [];
  let sanitizedTerminalGrowth = inputs.terminalGrowthRate;
  if (sanitizedTerminalGrowth > TERMINAL_GROWTH_CAP) {
    sanitizedTerminalGrowth = TERMINAL_GROWTH_CAP;
    warnings.push("Terminal growth rate auto-capped at 3.0% to reflect long-term GDP constraints and eliminate model inflation bias.");
  }

  // Guard: the Gordon terminal value is undefined (or negative) unless the discount rate exceeds terminal growth.
  if (inputs.discountRate <= sanitizedTerminalGrowth) {
    warnings.push(
      `Discount rate (${(inputs.discountRate * 100).toFixed(1)}%) must exceed terminal growth (${(sanitizedTerminalGrowth * 100).toFixed(1)}%) — no valuation produced.`,
    );
    return { enterpriseValue: 0, equityValue: 0, terminalValueContributionPercentage: 0, warnings };
  }

  let currentCashFlow = inputs.baseCashFlow;
  let sumPresentValueFreeCashFlows = 0;
  for (let i = 0; i < inputs.growthRates.length; i++) {
    currentCashFlow = currentCashFlow * (1 + inputs.growthRates[i]);
    sumPresentValueFreeCashFlows += currentCashFlow / Math.pow(1 + inputs.discountRate, i + 1);
  }
  const terminalYearCashFlow = currentCashFlow * (1 + sanitizedTerminalGrowth);
  const presentValueTerminalValue =
    terminalYearCashFlow / (inputs.discountRate - sanitizedTerminalGrowth) / Math.pow(1 + inputs.discountRate, inputs.growthRates.length);
  const totalEnterpriseValue = sumPresentValueFreeCashFlows + presentValueTerminalValue;

  // Guard: a share of a zero or negative total isn't meaningful (and would be NaN at exactly zero).
  if (totalEnterpriseValue <= 0) {
    warnings.push("Projected cash flows produce a non-positive enterprise value — check the base cash flow.");
    return { enterpriseValue: 0, equityValue: 0, terminalValueContributionPercentage: 0, warnings };
  }

  const terminalContribution = (presentValueTerminalValue / totalEnterpriseValue) * 100;
  if (terminalContribution > TERMINAL_SHARE_WARNING_PCT) {
    warnings.push(
      `Terminal value represents ${terminalContribution.toFixed(1)}% of total enterprise value. Near-term growth profiles may require optimization.`,
    );
  }
  return {
    enterpriseValue: Math.max(0, totalEnterpriseValue),
    equityValue: Math.max(0, totalEnterpriseValue - inputs.netDebt),
    terminalValueContributionPercentage: terminalContribution,
    warnings,
  };
}
