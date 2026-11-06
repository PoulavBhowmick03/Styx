# Friction

Observations from building this adapter. Times are not measured.

1. **The docs do not show how to read a `bytes` column back.** The Select Fields and Filter pages cover other types. The Column Types page says "read hex back" but gives no example. **Expected:** one read example. **What happened:** we found `BytesValue = Value<"bytes", Hex>` in the SDK's type definitions, so the value is at `.value`.
2. **The SDK changed shape recently.** Version 0.8.1 has no `./schema` export and no `rabdi` chain, while the current docs need both, and 1.0.0 came out on 30 October 2026. **Expected:** a stated minimum version in the guide. **To reproduce:** `npm install @arkiv-network/sdk@0.8.1`, then import `@arkiv-network/sdk/schema`.
3. **The RPC URL is not listed in the first-entity guide.** The `rabdi` helper hides it, which is convenient, but we had to read it off the chain object to confirm it.

**Not yet exercised:** publishing, the faucet and access keys.
