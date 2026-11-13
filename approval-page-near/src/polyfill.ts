// Wallet Selector's signMessage checks the nonce with the global Buffer.isBuffer
// (@near-wallet-selector/core), which browsers do not have. Imported first in main.ts.
import { Buffer } from 'buffer';
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
