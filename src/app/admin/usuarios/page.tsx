import { requirePage } from "@/lib/auth";
import UsersClient from "./UsersClient";

export default async function UsuariosPage() {
  await requirePage("/admin");
  return <UsersClient />;
}
