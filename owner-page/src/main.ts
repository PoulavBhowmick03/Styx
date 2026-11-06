import { getAddress, type Hex } from "viem";

import {
  ApprovalError,
  buildSignatureFile,
  parseOwnerConfig,
  parsePending,
  reviewPending,
  typedDataRequest,
  type OwnerConfig,
  type Pending,
} from "./approval";

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element ${id}`);
  return found as T;
}

const configInput = element<HTMLInputElement>("config-file");
const pendingInput = element<HTMLInputElement>("pending-file");
const review = element<HTMLElement>("review");
const signButton = element<HTMLButtonElement>("sign");
const statusLine = element<HTMLElement>("status");
const output = element<HTMLElement>("output");
const outputText = element<HTMLTextAreaElement>("output-text");
const download = element<HTMLAnchorElement>("download");

let config: OwnerConfig | undefined;
let pending: Pending | undefined;

function showStatus(message: string, isError = false): void {
  statusLine.textContent = message;
  statusLine.classList.toggle("error", isError);
}

function resetReview(): void {
  review.hidden = true;
  signButton.hidden = true;
  output.hidden = true;
}

// `textContent` only: the invoice reference is agent-supplied text and must never be parsed as HTML.
function render(): void {
  resetReview();
  if (!config || !pending) return;
  try {
    const view = reviewPending(pending, config, BigInt(Math.floor(Date.now() / 1000)));
    element("vault").textContent = view.vault;
    element("vendor").textContent = view.vendorLabel;
    element("recipient").textContent = view.recipient;
    element("amount").textContent = view.amount;
    element("invoice").textContent = view.invoiceReference;
    element("expiry").textContent = view.expiresAt;
    element("rule").textContent = view.exceededRule;
    element("digest").textContent = view.digest;
    review.hidden = false;
    signButton.hidden = false;
    showStatus("Check every field, then sign with the owner wallet.");
  } catch (error) {
    showStatus(error instanceof ApprovalError ? error.message : "This approval could not be read.", true);
  }
}

async function readJson(input: HTMLInputElement): Promise<unknown> {
  const file = input.files?.[0];
  if (!file) throw new ApprovalError("no file selected");
  try {
    return JSON.parse(await file.text());
  } catch {
    throw new ApprovalError("the file is not valid JSON");
  }
}

function handleLoad(input: HTMLInputElement, apply: (value: unknown) => void): void {
  input.addEventListener("change", () => {
    readJson(input)
      .then((value) => {
        apply(value);
        render();
      })
      .catch((error: unknown) => {
        resetReview();
        showStatus(error instanceof ApprovalError ? error.message : "The file could not be read.", true);
      });
  });
}

handleLoad(configInput, (value) => {
  config = parseOwnerConfig(value);
  showStatus("Owner config loaded.");
});
handleLoad(pendingInput, (value) => {
  pending = parsePending(value);
  showStatus("Approval request loaded.");
});

signButton.addEventListener("click", () => {
  void sign();
});

async function sign(): Promise<void> {
  if (!config || !pending) return;
  const wallet = window.ethereum;
  if (!wallet) {
    showStatus("No wallet found in this browser profile.", true);
    return;
  }
  signButton.disabled = true;
  try {
    const accounts = (await wallet.request({ method: "eth_requestAccounts" })) as string[];
    const account = accounts[0] ? getAddress(accounts[0]) : undefined;
    if (account !== config.owner) {
      showStatus("Connect the owner account in your wallet, then try again.", true);
      return;
    }
    const chainId = BigInt((await wallet.request({ method: "eth_chainId" })) as string);
    if (chainId !== config.chainId) {
      showStatus(`Switch your wallet to chain ${config.chainId}, then try again.`, true);
      return;
    }
    const signature = (await wallet.request({
      method: "eth_signTypedData_v4",
      params: [account, typedDataRequest(pending)],
    })) as Hex;
    const file = await buildSignatureFile(pending, config, signature);
    outputText.value = file;
    download.href = URL.createObjectURL(new Blob([file], { type: "application/json" }));
    download.download = `signature-${pending.payment.paymentId.slice(2, 14)}.json`;
    output.hidden = false;
    showStatus("Signed. Give this file to the agent's erebus_submit_payment tool.");
  } catch (error) {
    showStatus(error instanceof ApprovalError ? error.message : "The wallet did not sign.", true);
  } finally {
    signButton.disabled = false;
  }
}
