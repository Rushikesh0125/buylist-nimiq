import { useRef, useState } from "react";
import { init, NimiqProviderError } from "@nimiq/mini-app-sdk";
import { api } from "./api";

export default function NimiqSignIn({ onSuccess }: { onSuccess: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);

  async function signIn() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const wallet = await init().catch(() => {
        throw new Error("Open Buylist inside Nimiq Pay to use wallet sign-in.");
      });
      const { message } = await api<{ message: string }>(
        "/api/auth/nimiq/start",
        "POST",
        {},
      );
      const proof = await wallet.sign(message);
      await api("/api/auth/nimiq/verify", "POST", proof);
      onSuccess();
    } catch (error) {
      setError(
        NimiqProviderError.is(error) && error.type === "PERMISSION_DENIED"
          ? "Wallet sign-in canceled."
          : error instanceof Error
            ? error.message
            : "Wallet sign-in failed.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="nimiq-sign-in">
      <button
        type="button"
        className="site-cta"
        disabled={busy}
        onClick={() => void signIn()}
      >
        {busy ? "Signing in…" : "Continue with Nimiq Pay"}
      </button>
      {error && <p role="status">{error}</p>}
    </div>
  );
}
