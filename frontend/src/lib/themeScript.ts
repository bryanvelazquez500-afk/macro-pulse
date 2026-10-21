// Plain constants (no React), so the server layout can inline the script; see lib/theme.ts.

export const THEME_KEY = "mp-theme";

/** Runs before React: saved choice, else the system setting. Follows system changes while nothing is saved. */
export const THEME_SCRIPT = `(function(){var d=document.documentElement,k="${THEME_KEY}",s=null;try{s=localStorage.getItem(k)}catch(e){}
var m=window.matchMedia&&matchMedia("(prefers-color-scheme: dark)");function a(){var t=s==="light"||s==="dark"?s:m&&m.matches?"dark":"light";d.dataset.theme=t}a();
if(m&&m.addEventListener)m.addEventListener("change",function(){try{s=localStorage.getItem(k)}catch(e){}a()})})();`;

/**
 * Starts the default comparison's first requests from <head>, before the app's JavaScript has loaded,
 * so data is usually ready by the time React renders. lib/api.ts adopts these promises (window.__mpEarly)
 * instead of requesting again. Paths must match what the app requests for its opening company (AAPL).
 */
export function earlyFetchScript(apiUrl: string): string {
  const c = "/api/companies/AAPL";
  const paths = [
    c,
    `${c}/financials?period=annual&limit=12`,
    `${c}/peers?limit=6`,
    `${c}/news?limit=10`,
    `${c}/valuation-inputs`,
    `${c}/dcf-inputs`,
  ];
  return `(function(){try{var a=${JSON.stringify(apiUrl)},e=window.__mpEarly={};${JSON.stringify(paths)}.forEach(function(p){e[p]=fetch(a+p)})}catch(x){}})();`;
}
