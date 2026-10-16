/** A package size, for the phone Hub and the glasses store alike. iOS uses decimal units, as Settings and Software Update do; Android keeps binary. */
export function formatFileSize(value: number): string {
  const k = global.isIOS ? 1000 : 1024;
  if (value < k) return `${value} B`;
  if (value < k * k) return `${(value / k).toFixed(1)} KB`;
  return `${(value / (k * k)).toFixed(1)} MB`;
}
