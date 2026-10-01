import { PROTOCOL } from './networks.js';

/** Format integer connects without losing monetary precision. */
export function formatMoney(value?: string, unit = true): string {
  if (value === undefined) return '—';
  try {
    const n = BigInt(value),
      negative = n < 0n,
      a = negative ? -n : n,
      connectsPerCoin = BigInt(PROTOCOL.connectsPerCoin);
    const fraction = (a % connectsPerCoin).toString().padStart(PROTOCOL.decimals, '0').replace(/0+$/, '');
    return `${negative ? '-' : ''}${(a / connectsPerCoin).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}${unit ? ` ${PROTOCOL.ticker}` : ''}`;
  } catch {
    return '—';
  }
}
