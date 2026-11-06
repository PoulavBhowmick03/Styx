import { exportJWK, generateKeyPair, createLocalJWKSet, SignJWT, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { StepUp, type StepUpConfig } from "../server/stepup";

const ISSUER = "https://issuer.test";
const CLIENT = "client-1";
const SUBJECT = "owner-subject";
const DIGEST = `0x${"ab".repeat(32)}`;
const START = 1_800_000_000;

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let keySet: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = await exportJWK(pair.publicKey);
  keySet = createLocalJWKSet({ keys: [{ ...jwk, alg: "RS256", use: "sig", kid: "k" }] });
});

interface Scenario {
  claims?: Record<string, unknown>;
  signer?: CryptoKey;
  audience?: string;
  issuer?: string;
  tokenStatus?: number;
  config?: Partial<StepUpConfig>;
  discoveryStatus?: number;
}

function harness(scenario: Scenario = {}) {
  const clock = { now: START };
  const seen: { body?: URLSearchParams; authorization?: string; nonce?: string } = {};
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === `${ISSUER}/.well-known/openid-configuration`) {
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
        }),
        { status: scenario.discoveryStatus ?? 200 },
      );
    }
    seen.body = new URLSearchParams(String(init?.body));
    seen.authorization = String((init?.headers as Record<string, string>).authorization);
    if (scenario.tokenStatus) return new Response("{}", { status: scenario.tokenStatus });
    const idToken = await new SignJWT({ nonce: seen.nonce, auth_time: clock.now, ...scenario.claims })
      .setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuer(scenario.issuer ?? ISSUER)
      .setAudience(scenario.audience ?? CLIENT)
      .setSubject(SUBJECT)
      .setIssuedAt(clock.now)
      .setExpirationTime(clock.now + 600)
      .sign(scenario.signer ?? privateKey);
    return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
  }) as typeof fetch;
  const stepUp = new StepUp(
    {
      discoveryUrl: `${ISSUER}/.well-known/openid-configuration`,
      clientId: CLIENT,
      clientSecret: "test-only",
      redirectUri: "https://owner.test/callback",
      ownerSubject: SUBJECT,
      acceptedAcr: [],
      ...scenario.config,
    },
    { fetch: fakeFetch, nowSeconds: () => clock.now, keySet },
  );
  return {
    stepUp,
    clock,
    seen,
    /** Starts an attempt, returning what World would echo back on the redirect. */
    async begin() {
      const { attemptId, authorizeUrl } = await stepUp.start(DIGEST);
      const params = new URL(authorizeUrl).searchParams;
      seen.nonce = params.get("nonce") ?? undefined;
      return { attemptId, params, state: params.get("state") ?? "" };
    },
  };
}

function redirect(state: string, extra: Record<string, string> = { code: "code-1", iss: ISSUER }) {
  return new URLSearchParams({ state, ...extra });
}

describe("the authorization request", () => {
  it("asks for fresh authentication with PKCE, state and nonce", async () => {
    const { params } = await harness().begin();
    expect(params.get("max_age")).toBe("0");
    expect(params.get("scope")).toBe("openid");
    expect(params.get("response_type")).toBe("code");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBeTruthy();
    expect(params.get("state")).toBeTruthy();
    expect(params.get("nonce")).toBeTruthy();
    expect(params.has("client_secret")).toBe(false);
  });

  it("refuses a malformed digest and an unavailable issuer", async () => {
    await expect(harness().stepUp.start("nope")).rejects.toThrow(/digest/);
    await expect(harness({ discoveryStatus: 503 }).stepUp.start(DIGEST)).rejects.toThrow(/unavailable/);
  });
});

describe("the success path", () => {
  it("approves once, for the digest it started with", async () => {
    const h = harness();
    const { attemptId, state } = await h.begin();
    expect(h.stepUp.status(attemptId).status).toBe("pending");
    expect(h.stepUp.consume(attemptId, DIGEST)).toBe(false);

    expect((await h.stepUp.callback(redirect(state))).status).toBe("approved");
    expect(h.seen.body?.get("code")).toBe("code-1");
    expect(h.seen.body?.get("code_verifier")).toBeTruthy();
    expect(h.seen.authorization).toMatch(/^Basic /);

    expect(h.stepUp.consume(attemptId, `0x${"cd".repeat(32)}`)).toBe(false);
    expect(h.stepUp.consume(attemptId, DIGEST)).toBe(true);
    expect(h.stepUp.consume(attemptId, DIGEST)).toBe(false);
  });
});

describe("failure paths never reach signing", () => {
  async function denied(scenario: Scenario, query?: (state: string) => URLSearchParams) {
    const h = harness(scenario);
    const { attemptId, state } = await h.begin();
    const outcome = await h.stepUp.callback(query ? query(state) : redirect(state));
    expect(outcome.status).toBe("denied");
    expect(h.stepUp.consume(attemptId, DIGEST)).toBe(false);
    return outcome;
  }

  it("a cancelled or denied authentication", async () => {
    const outcome = await denied({}, (state) => redirect(state, { error: "access_denied", iss: ISSUER }));
    expect(outcome).toMatchObject({ reason: expect.stringContaining("cancelled") });
  });

  it("an unexpected or missing iss", async () => {
    await denied({}, (state) => redirect(state, { code: "c", iss: "https://evil.test" }));
    await denied({}, (state) => redirect(state, { code: "c" }));
  });

  it("no code", async () => {
    await denied({}, (state) => redirect(state, { iss: ISSUER }));
  });

  it("a token endpoint failure, including 503", async () => {
    await denied({ tokenStatus: 503 });
    await denied({ tokenStatus: 400 });
  });

  it("a wrong signature, issuer or audience", async () => {
    await denied({ signer: otherKey });
    await denied({ issuer: "https://evil.test" });
    await denied({ audience: "another-client" });
  });

  it("a nonce from another attempt", async () => {
    await denied({ claims: { nonce: "other" } });
  });

  it("stale or missing auth_time", async () => {
    await denied({ claims: { auth_time: START - 3600 } });
    await denied({ claims: { auth_time: undefined } });
  });

  it("an authentication class that is not accepted", async () => {
    await denied({
      config: { acceptedAcr: ["https://world.org/oidc/acr/orb"] },
      claims: { acr: "https://world.org/oidc/acr/other" },
    });
  });

  it("someone other than the enrolled owner", async () => {
    await denied({ config: { ownerSubject: "someone-else" } });
  });

  it("no enrolled owner, showing the subject to enroll", async () => {
    const outcome = await denied({ config: { ownerSubject: undefined } });
    expect(outcome).toMatchObject({ subject: SUBJECT });
  });

  it("an expired attempt", async () => {
    const h = harness();
    const { attemptId, state } = await h.begin();
    h.clock.now += 301;
    expect((await h.stepUp.callback(redirect(state))).status).toBe("denied");
    expect(h.stepUp.consume(attemptId, DIGEST)).toBe(false);
  });

  it("an approval that expires before it is used", async () => {
    const h = harness();
    const { attemptId, state } = await h.begin();
    expect((await h.stepUp.callback(redirect(state))).status).toBe("approved");
    h.clock.now += 301;
    expect(h.stepUp.status(attemptId).status).toBe("denied");
    expect(h.stepUp.consume(attemptId, DIGEST)).toBe(false);
  });

  it("an unknown state, which changes no attempt", async () => {
    const h = harness();
    const { attemptId } = await h.begin();
    expect((await h.stepUp.callback(redirect("unknown"))).status).toBe("denied");
    expect(h.stepUp.status(attemptId).status).toBe("pending");
  });

  it("a replayed callback, which cannot change a denial", async () => {
    const h = harness();
    const { attemptId, state } = await h.begin();
    await h.stepUp.callback(redirect(state, { error: "access_denied", iss: ISSUER }));
    expect((await h.stepUp.callback(redirect(state))).status).toBe("denied");
    expect(h.stepUp.consume(attemptId, DIGEST)).toBe(false);
  });
});
