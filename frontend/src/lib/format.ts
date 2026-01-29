export function formatKg(value: number, opts?: { decimals?: number }) {
  const decimals = opts?.decimals ?? 0;
  const v = Number.isFinite(value) ? value : 0;
  return `${v.toLocaleString("de-CH", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} kg`;
}

export function formatPercent(value: number, opts?: { decimals?: number }) {
  const decimals = opts?.decimals ?? 0;
  const v = Number.isFinite(value) ? value : 0;
  return `${(v * 100).toLocaleString("de-CH", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} %`;
}
