// Summary rows and page text. textContent only: nothing from a request is parsed as HTML.
export function summary(rows: [label: string, value: string, big?: boolean][]) {
  (document.querySelector('#summary-card') as HTMLElement).hidden = false;
  document.querySelector('#summary')!.replaceChildren(...rows.map(([label, value, big]) => {
    const row = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
    row.className = 'row'; dd.className = big ? 'key' : 'value';
    dt.textContent = label; dd.textContent = value; row.append(dt, dd);
    return row;
  }));
}
export function text(id: string, value: string) { document.querySelector('#' + id)!.textContent = value; }
export function showDetails(value: string) { text('details', value); (document.querySelector('#more') as HTMLElement).hidden = false; }
export const shortKey = (k: string) => k.length > 26 ? `${k.slice(0, 16)}…${k.slice(-6)}` : k;
export const amount = (formatted: string) => formatted.replace(/\.?0+ USDC$/, ' USDC');
const CHAINS: Record<number, string> = { 5042002: 'Arc testnet', 84532: 'Base Sepolia' };
export const chainName = (id: number | null | undefined) => id == null ? 'NEAR' : CHAINS[id] ?? `EVM chain ${id}`;
