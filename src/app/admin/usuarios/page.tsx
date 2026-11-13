import { requirePage } from "@/lib/auth";
import UsersClient from "./UsersClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Usuarios" };

export default async function UsuariosPage() {
  await requirePage("/admin");
  return <UsersClient />;
}
