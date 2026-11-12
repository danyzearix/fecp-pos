"use client";

export default function LogoutButton() {
  async function out() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }
  return (
    <button onClick={out} className="inline-flex items-center min-h-11 px-2 text-sm text-err-ink underline">
      Salir
    </button>
  );
}
