"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    const supabase = createClient();

    if (mode === "sign-in") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError(error.message);
      } else {
        router.push("/");
        router.refresh();
      }
    } else {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) {
        setError(error.message);
      } else {
        setInfo("Check your email to confirm your account, then sign in.");
        setMode("sign-in");
      }
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm flex flex-col gap-4 rounded-lg border border-border bg-panel p-6"
      >
        <div>
          <h1 className="text-base font-medium">Schedule</h1>
          <p className="mt-1 text-xs text-muted">
            {mode === "sign-in" ? "Sign in to your schedule." : "Create your account."}
          </p>
        </div>

        <label className="flex flex-col gap-1 text-xs text-muted">
          Email
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="min-h-9 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text outline-none focus-visible:border-accent"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted">
          Password
          <input
            type="password"
            required
            minLength={6}
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="min-h-9 rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text outline-none focus-visible:border-accent"
          />
        </label>

        {error && <p className="text-xs text-accent-text">{error}</p>}
        {info && <p className="text-xs text-muted">{info}</p>}

        <button
          type="submit"
          disabled={busy}
          className="mt-1 h-9 rounded-md border border-accent text-sm font-medium text-accent transition-colors hover:bg-accent/10 disabled:opacity-45"
        >
          {busy ? "..." : mode === "sign-in" ? "Sign in" : "Create account"}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode(mode === "sign-in" ? "sign-up" : "sign-in");
            setError(null);
            setInfo(null);
          }}
          className="text-xs text-muted underline underline-offset-2 hover:text-text"
        >
          {mode === "sign-in" ? "Need an account? Create one" : "Already have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}
