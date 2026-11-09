import { useRef, useState } from "react";
import { init, NimiqProviderError } from "@nimiq/mini-app-sdk";
import { api } from "./api";

const approvalTimeoutMs = 45_000;

async function requestSignature(
  wallet: Awaited<ReturnType<typeof init>>,
  message: string,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      wallet.sign(message),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Nimiq Pay didn’t respond. Close and reopen Buylist from Mini Apps, then try again.",
              ),
            ),
          approvalTimeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export default function NimiqSignIn({ onSuccess }: { onSuccess: () => void }) {
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [needsWallet, setNeedsWallet] = useState(false);
  const running = useRef(false);

  async function signIn() {
    if (running.current) return;
    running.current = true;
    setStage("Connecting to Nimiq Pay…");
    setError("");
    setNeedsWallet(false);
    try {
      const wallet = await init({ timeout: 3000 }).catch(() => {
        setNeedsWallet(true);
        throw new Error("Open Buylist inside Nimiq Pay to use wallet sign-in.");
      });
      const { message } = await api<{ message: string }>(
        "/api/auth/nimiq/start",
        "POST",
        {},
        AbortSignal.timeout(10_000),
      );
      setStage("Approve the request in Nimiq Pay…");
      const proof = await requestSignature(wallet, message);
      setStage("Verifying your signature…");
      await api(
        "/api/auth/nimiq/verify",
        "POST",
        proof,
        AbortSignal.timeout(10_000),
      );
      onSuccess();
    } catch (error) {
      setError(
        NimiqProviderError.is(error) && error.type === "PERMISSION_DENIED"
          ? "Wallet sign-in canceled."
          : error instanceof Error && error.name === "TimeoutError"
            ? "Buylist didn’t respond in time. Try signing in again."
            : error instanceof Error
              ? error.message
              : "Wallet sign-in failed.",
      );
    } finally {
      running.current = false;
      setStage("");
    }
  }

  return (
    <div className="nimiq-sign-in">
      <button
        type="button"
        className="site-cta"
        disabled={!!stage}
        onClick={() => void signIn()}
      >
        Continue with Nimiq Pay
      </button>
      {stage && <p role="status">{stage}</p>}
      {error && <p role="status">{error}</p>}
      {needsWallet && location.protocol === "https:" && (
        <a
          className="underlink"
          href={"nimiqpay://miniapp?url=" + encodeURIComponent(location.href)}
        >
          Open in Nimiq Pay
        </a>
      )}
    </div>
  );
}
