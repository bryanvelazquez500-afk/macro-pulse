// Plain constants (no React), so the server layout can inline the script; see lib/theme.ts.

export const THEME_KEY = "mp-theme";

/** Runs before React: saved choice, else the system setting. Follows system changes while nothing is saved. */
export const THEME_SCRIPT = `(function(){var d=document.documentElement,k="${THEME_KEY}",s=null;try{s=localStorage.getItem(k)}catch(e){}
var m=window.matchMedia&&matchMedia("(prefers-color-scheme: dark)");function a(){var t=s==="light"||s==="dark"?s:m&&m.matches?"dark":"light";d.dataset.theme=t}a();
if(m&&m.addEventListener)m.addEventListener("change",function(){try{s=localStorage.getItem(k)}catch(e){}a()})})();`;
