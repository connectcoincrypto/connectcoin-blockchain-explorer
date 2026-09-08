/** Transaction outputs are paginated in groups of 20. Deep links must select the containing page. */
export function outputPath(txid: string, index: number): string {
  return `/tx/${txid}?outputsPage=${Math.floor(index / 20) + 1}#output-${index}`;
}
