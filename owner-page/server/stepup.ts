// World step-up authentication for the owner page. Everything here decides whether one signing
// attempt may go ahead; the contract never checks World, and the owner's signature is what
// authorizes a payment. Any failure leaves the attempt unapproved.

import { createHash, randomBytes } from "node:crypto";

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const ATTEMPT_LIFETIME_SECONDS = 300;
const CLOCK_TOLERANCE_SECONDS = 5;
const DIGEST = /^0x[0-9a-f]{64}$/;

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface StepUpConfig {
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** The owner's enrolled World subject. Unset means every attempt is denied, showing the subject. */
  ownerSubject?: string;
  /** Acceptable `acr` values. Empty accepts whatever the issuer returned. */
  acceptedAcr: string[];
}

export interface Dependencies {
  fetch: typeof fetch;
  nowSeconds: () => number;
  /** Replaces the remote key set in tests. */
  keySet?: JWTVerifyGetKey;
}

export type AttemptState =
  | { status: "pending" }
  | { status: "approved" }
  | { status: "denied"; reason: string; subject?: string };

interface Attempt {
  digest: string;
  state: string;
  nonce: string;
  verifier: string;
  startedAt: number;
  outcome: AttemptState;
  consumed: boolean;
}

export class StepUpError extends Error {}

function random(): string {
  return randomBytes(32).toString("base64url");
}

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export class StepUp {
  private readonly attempts = new Map<string, Attempt>();
  private readonly byState = new Map<string, string>();
  private discovery?: Discovery;
  private keySet?: JWTVerifyGetKey;

  constructor(
    private readonly config: StepUpConfig,
    private readonly deps: Dependencies,
  ) {}

  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const response = await this.deps.fetch(this.config.discoveryUrl);
    if (!response.ok) throw new StepUpError("World's discovery document is unavailable");
    const discovery = (await response.json()) as Discovery;
    if (!discovery.issuer || !discovery.authorization_endpoint || !discovery.token_endpoint || !discovery.jwks_uri) {
      throw new StepUpError("World's discovery document is incomplete");
    }
    this.discovery = discovery;
    this.keySet = this.deps.keySet ?? createRemoteJWKSet(new URL(discovery.jwks_uri));
    return discovery;
  }

  /** Starts one attempt bound to the exact digest the owner is about to sign. */
  async start(digest: string): Promise<{ attemptId: string; authorizeUrl: string }> {
    if (!DIGEST.test(digest)) throw new StepUpError("invalid approval digest");
    const discovery = await this.discover();
    const attemptId = random();
    const attempt: Attempt = {
      digest,
      state: random(),
      nonce: random(),
      verifier: random(),
      startedAt: this.deps.nowSeconds(),
      outcome: { status: "pending" },
      consumed: false,
    };
    this.attempts.set(attemptId, attempt);
    this.byState.set(attempt.state, attemptId);
    const url = new URL(discovery.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: "openid",
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge: challenge(attempt.verifier),
      code_challenge_method: "S256",
      // Fresh authentication for this transaction, even with an existing browser session.
      max_age: "0",
    }).toString();
    return { attemptId, authorizeUrl: url.toString() };
  }

  /** Handles World's redirect. Unknown state changes nothing, since it may not be our attempt. */
  async callback(query: URLSearchParams): Promise<AttemptState> {
    const attemptId = this.byState.get(query.get("state") ?? "");
    const attempt = attemptId ? this.attempts.get(attemptId) : undefined;
    if (!attempt) return { status: "denied", reason: "this response matches no attempt" };
    if (attempt.outcome.status !== "pending") return attempt.outcome;
    attempt.outcome = await this.evaluate(attempt, query).catch(() => ({
      status: "denied" as const,
      reason: "World could not be verified",
    }));
    return attempt.outcome;
  }

  private async evaluate(attempt: Attempt, query: URLSearchParams): Promise<AttemptState> {
    const deny = (reason: string, subject?: string): AttemptState => ({
      status: "denied",
      reason,
      ...(subject ? { subject } : {}),
    });
    const discovery = await this.discover();
    if (query.get("iss") !== discovery.issuer) return deny("the response came from an unexpected issuer");
    const error = query.get("error");
    if (error) return deny(error === "access_denied" ? "the authentication was cancelled or denied" : error);
    const code = query.get("code");
    if (!code) return deny("the response has no authorization code");
    const now = this.deps.nowSeconds();
    if (now > attempt.startedAt + ATTEMPT_LIFETIME_SECONDS) return deny("this attempt has expired");

    const credentials = Buffer.from(
      `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`,
    ).toString("base64");
    const response = await this.deps.fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { authorization: `Basic ${credentials}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.config.redirectUri,
        code_verifier: attempt.verifier,
      }).toString(),
    });
    // A 503 from World is temporary unavailability, never approval.
    if (!response.ok) return deny("World refused or could not complete the token exchange");
    const { id_token: idToken } = (await response.json()) as { id_token?: string };
    if (!idToken) return deny("World returned no ID token");

    const { payload } = await jwtVerify(idToken, this.keySet!, {
      issuer: discovery.issuer,
      audience: this.config.clientId,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: new Date(now * 1000),
    });
    if (payload.nonce !== attempt.nonce) return deny("the ID token belongs to another attempt");
    const authTime = payload.auth_time;
    if (typeof authTime !== "number" || authTime < attempt.startedAt - CLOCK_TOLERANCE_SECONDS) {
      return deny("the authentication was not fresh");
    }
    if (this.config.acceptedAcr.length > 0 && !this.config.acceptedAcr.includes(String(payload.acr))) {
      return deny("this authentication class is not accepted");
    }
    if (!this.config.ownerSubject) {
      return deny("no owner is enrolled; set WORLD_OWNER_SUBJECT to this subject to enroll", payload.sub);
    }
    if (payload.sub !== this.config.ownerSubject) return deny("this is not the enrolled owner");
    return { status: "approved" };
  }

  /** Reads an attempt for the page, reporting expiry as a denial. */
  status(attemptId: string): AttemptState {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return { status: "denied", reason: "unknown attempt" };
    if (this.deps.nowSeconds() > attempt.startedAt + ATTEMPT_LIFETIME_SECONDS) {
      return { status: "denied", reason: "this attempt has expired" };
    }
    return attempt.outcome;
  }

  /** Spends an approval on one signature for one digest. It succeeds at most once. */
  consume(attemptId: string, digest: string): boolean {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.digest !== digest || attempt.consumed) return false;
    if (this.status(attemptId).status !== "approved") return false;
    attempt.consumed = true;
    return true;
  }
}
