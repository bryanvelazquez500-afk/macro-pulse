export enum BusinessType {
  SAAS = "SAAS",
  MARKETPLACE = "MARKETPLACE",
  ASSET_HEAVY = "ASSET_HEAVY",
  SERVICE = "SERVICE",
}

export interface BusinessProfile {
  id: string;
  name: string;
  type: BusinessType;
  metrics: {
    revenue: number;
    ebitda: number;
    cash: number;
    debt: number;
    mrr?: number;
    churnRate?: number;
    gmv?: number;
    takeRate?: number;
    netAssetValue?: number;
    capEx?: number;
  };
}

export interface RoutingResult {
  recommendedModel: string;
  requiredInputs: string[];
  justification: string;
}

export function routeBusinessToModel(business: BusinessProfile): RoutingResult {
  switch (business.type) {
    case BusinessType.SAAS:
      return {
        recommendedModel: "Multi-Period Discounted Cash Flow (DCF) via Recurring Revenue Build",
        requiredInputs: ["mrr", "churnRate", "discountRate", "terminalGrowth"],
        justification:
          "Subscription businesses are valued on recurring customer lifetime streams. Asset models would structurally undervalue this business by ignoring customer retention capital.",
      };
    case BusinessType.MARKETPLACE:
      return {
        recommendedModel: "GMV/Take-Rate Forward Multiple Hybrid Analysis",
        requiredInputs: ["gmv", "takeRate", "forwardRevenueMultiple"],
        justification:
          "Platforms scale through network effects and high transactional velocity. Value is derived via gross volume processing margins.",
      };
    case BusinessType.ASSET_HEAVY:
      return {
        recommendedModel: "3-Statement CapEx Adjusted Asset Valuation & NAV",
        requiredInputs: ["netAssetValue", "capEx", "ebitdaMultiple"],
        justification:
          "Physical infrastructure and inventory turns represent the structural backbone of valuation. Requires tangible asset floor protections.",
      };
    case BusinessType.SERVICE:
      return {
        recommendedModel: "Utilization Rate & Billable Hours Discounted Cash Flow",
        requiredInputs: ["revenue", "ebitda", "discountRate"],
        justification:
          "Human capital businesses scale relative to staff margins and billable utilization. Terminal multiple weights must be muted.",
      };
    default:
      throw new Error(`Unsupported business type mapping.`);
  }
}
